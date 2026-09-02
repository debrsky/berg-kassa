<?php

declare(strict_types=1);

final class DataSchemaNotFound extends RuntimeException
{
    public function __construct(public readonly string $schema)
    {
        parent::__construct("Схема {$schema} отсутствует. Выберите другую схему.");
    }
}

function loadEnv(string $path): void
{
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#') || !str_contains($line, '=')) {
            continue;
        }
        [$name, $value] = explode('=', $line, 2);
        $name = trim($name);
        if (getenv($name) === false) {
            putenv($name . '=' . trim($value, " \t\n\r\0\x0B\"'"));
        }
    }
}

function env(string $name): string
{
    $value = getenv($name);
    if ($value === false || $value === '') {
        throw new RuntimeException("Missing environment setting: {$name}");
    }
    return $value;
}

function db(): PDO
{
    static $pdo;
    if ($pdo instanceof PDO) {
        return $pdo;
    }

    $dsn = sprintf(
        'pgsql:host=%s;port=%d;dbname=%s',
        env('LOCAL_PGSQL_HOST'),
        (int) env('LOCAL_PGSQL_PORT'),
        env('LOCAL_PGSQL_DATABASE'),
    );
    $pdo = new PDO($dsn, env('LOCAL_PGSQL_USER'), env('LOCAL_PGSQL_PASSWORD'), [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
    ]);
    return $pdo;
}

function initAuth(PDO $pdo): void
{
    $pdo->exec(<<<'SQL'
        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE TABLE IF NOT EXISTS auth.users (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            login text NOT NULL,
            password_hash text NOT NULL,
            data_schema text[] NOT NULL,
            can_view_protected boolean NOT NULL DEFAULT false,
            is_active boolean NOT NULL DEFAULT true,
            created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS users_login_lower_idx ON auth.users (lower(login));
        CREATE TABLE IF NOT EXISTS auth.audit_log (
            id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
            created_at timestamptz NOT NULL DEFAULT now(),
            event text NOT NULL,
            user_id bigint,
            login text,
            ip inet,
            data_schema text,
            entity text,
            entity_id bigint,
            details jsonb NOT NULL DEFAULT '{}'::jsonb
        );
        CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON auth.audit_log (created_at);
        CREATE INDEX IF NOT EXISTS audit_log_event_idx ON auth.audit_log (event);
        CREATE INDEX IF NOT EXISTS audit_log_user_id_idx ON auth.audit_log (user_id);
        CREATE OR REPLACE FUNCTION auth.audit_log_append_only() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            IF current_setting('app.audit_maintenance', true) IS DISTINCT FROM 'on' THEN
                RAISE EXCEPTION 'Audit log is append-only';
            END IF;
            RETURN OLD;
        END $$;
        CREATE OR REPLACE TRIGGER audit_log_append_only
            BEFORE UPDATE OR DELETE ON auth.audit_log
            FOR EACH ROW EXECUTE FUNCTION auth.audit_log_append_only();
        REVOKE UPDATE, DELETE ON auth.audit_log FROM PUBLIC;
        ALTER TABLE auth.users DROP CONSTRAINT IF EXISTS users_data_schema_fkey;
        DO $$
        BEGIN
            IF (SELECT udt_name FROM information_schema.columns
                WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'data_schema') <> '_text' THEN
                ALTER TABLE auth.users ALTER COLUMN data_schema TYPE text[]
                    USING CASE WHEN data_schema IS NULL THEN ARRAY[]::text[] ELSE ARRAY[data_schema] END;
            END IF;
            IF to_regclass('auth.user_schemas') IS NOT NULL THEN
                EXECUTE 'UPDATE auth.users u SET data_schema = s.schemas FROM '
                    || '(SELECT user_id, array_agg(schema_name ORDER BY schema_name) schemas '
                    || 'FROM auth.user_schemas GROUP BY user_id) s WHERE s.user_id = u.id';
            END IF;
        END $$;
        UPDATE auth.users SET data_schema = ARRAY[]::text[] WHERE data_schema IS NULL;
        ALTER TABLE auth.users ALTER COLUMN data_schema SET NOT NULL;
        DROP TABLE IF EXISTS auth.user_schemas;
        DROP TABLE IF EXISTS auth.data_schemas;
    SQL);
}

function startAppSession(): void
{
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    session_cache_limiter('');
    session_name('berg_kassa_session');
    $forwardedProto = strtolower(trim(explode(',', (string) ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
    $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || strtolower((string) ($_SERVER['HTTP_HTTPS'] ?? '')) === 'on'
        || $forwardedProto === 'https';
    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => $secure,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    session_start();
}

function currentUser(): ?array
{
    if (empty($_SESSION['user_id'])) {
        return null;
    }
    $statement = db()->prepare(
        'SELECT id, login, to_json(data_schema)::text AS data_schemas_json, can_view_protected '
        . 'FROM auth.users WHERE id = :id AND is_active'
    );
    $statement->execute(['id' => $_SESSION['user_id']]);
    $user = $statement->fetch();
    if (!$user) {
        $_SESSION = [];
        return null;
    }
    $user['can_view_protected'] = (bool) $user['can_view_protected'];
    $user['data_schemas'] = json_decode($user['data_schemas_json'], true, flags: JSON_THROW_ON_ERROR);
    unset($user['data_schemas_json']);
    if (!$user['data_schemas']) {
        $_SESSION = [];
        return null;
    }
    $selected = (string) ($_SESSION['data_schema'] ?? '');
    $user['data_schema'] = in_array($selected, $user['data_schemas'], true) ? $selected : $user['data_schemas'][0];
    $_SESSION['data_schema'] = $user['data_schema'];
    return $user;
}

function requireUser(): array
{
    $user = currentUser();
    if (!$user) {
        auditEvent('access.denied', details: ['reason' => 'authentication_required']);
        jsonResponse(['error' => 'Authentication required'], 401);
    }
    return $user;
}

function useDataSchema(string $schema): void
{
    if (!preg_match('/^[a-z_][a-z0-9_]*$/', $schema)) {
        throw new RuntimeException('Invalid user data schema');
    }
    if (!schemaExists($schema)) {
        throw new DataSchemaNotFound($schema);
    }
    db()->exec('SET search_path TO "' . $schema . '", pg_catalog');
}

function schemaExists(string $schema): bool
{
    $statement = db()->prepare('SELECT 1 FROM pg_namespace WHERE nspname = :schema');
    $statement->execute(['schema' => $schema]);
    return (bool) $statement->fetchColumn();
}

function csrfToken(): string
{
    return $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
}

function auditEvent(
    string $event,
    ?array $user = null,
    ?string $entity = null,
    ?int $entityId = null,
    array $details = [],
    ?string $login = null,
    ?PDO $pdo = null,
): void {
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    $statement = ($pdo ?? db())->prepare(
        'INSERT INTO auth.audit_log (event, user_id, login, ip, data_schema, entity, entity_id, details) '
        . 'VALUES (:event, :user_id, :login, :ip, :data_schema, :entity, :entity_id, :details)'
    );
    $statement->execute([
        'event' => $event,
        'user_id' => $user['id'] ?? null,
        'login' => $login ?? ($user['login'] ?? null),
        'ip' => filter_var($ip, FILTER_VALIDATE_IP) ? $ip : null,
        'data_schema' => $user['data_schema'] ?? null,
        'entity' => $entity,
        'entity_id' => $entityId,
        'details' => json_encode($details, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR),
    ]);
}

function requireCsrf(?array $user = null): void
{
    if (!hash_equals(csrfToken(), (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) {
        auditEvent('access.denied', $user, details: ['reason' => 'invalid_csrf']);
        jsonResponse(['error' => 'Invalid CSRF token'], 403);
    }
}

function selectDataSchema(array $user): never
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }
    if (!hash_equals(csrfToken(), (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) {
        auditEvent('access.denied', $user, details: ['reason' => 'invalid_csrf']);
        jsonResponse(['error' => 'Invalid CSRF token'], 403);
    }
    $body = json_decode(file_get_contents('php://input'), true);
    $schema = (string) ($body['data_schema'] ?? '');
    if (!in_array($schema, $user['data_schemas'], true)) {
        auditEvent('access.denied', $user, details: ['reason' => 'schema_access_denied', 'requested_schema' => $schema]);
        jsonResponse(['error' => 'Schema access denied'], 403);
    }
    if (!schemaExists($schema)) {
        throw new DataSchemaNotFound($schema);
    }
    $_SESSION['data_schema'] = $schema;
    $user['data_schema'] = $schema;
    auditEvent('schema.selected', $user);
    jsonResponse(['ok' => true]);
}

function loginAttemptFile(string $ip): string
{
    // ponytail: local rate limit; move to a shared store when the app runs on multiple servers.
    return sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'berg-kassa-login-' . hash('sha256', $ip);
}

function loginAttempts(string $ip, int $now): array
{
    $handle = fopen(loginAttemptFile($ip), 'c+');
    if ($handle === false || !flock($handle, LOCK_EX)) {
        throw new RuntimeException('Unable to lock login rate limit');
    }
    $attempts = json_decode(stream_get_contents($handle) ?: '[]', true);
    $attempts = array_values(array_filter(is_array($attempts) ? $attempts : [], fn ($time) => is_int($time) && $time > $now - 60));
    return [$handle, $attempts];
}

function saveLoginAttempts($handle, array $attempts): void
{
    rewind($handle);
    ftruncate($handle, 0);
    fwrite($handle, json_encode($attempts, JSON_THROW_ON_ERROR));
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);
}

function login(): never
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }
    $now = time();
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
    [$attemptHandle, $attempts] = loginAttempts($ip, $now);
    if (count($attempts) >= 5) {
        saveLoginAttempts($attemptHandle, $attempts);
        auditEvent('login.rate_limited');
        jsonResponse(['error' => 'Слишком много попыток. Повторите через минуту.'], 429);
    }
    $body = json_decode(file_get_contents('php://input'), true);
    $login = trim((string) ($body['login'] ?? ''));
    $password = (string) ($body['password'] ?? '');
    $statement = db()->prepare(
        'SELECT id, login, password_hash FROM auth.users WHERE lower(login) = lower(:login) AND is_active'
    );
    $statement->execute(['login' => $login]);
    $account = $statement->fetch();
    if (!$account || !password_verify($password, $account['password_hash'])) {
        $attempts[] = $now;
        saveLoginAttempts($attemptHandle, $attempts);
        auditEvent('login.failed', login: $login);
        usleep(250_000);
        jsonResponse(['error' => 'Неверный логин или пароль'], 401);
    }
    saveLoginAttempts($attemptHandle, []);
    session_regenerate_id(true);
    $_SESSION = ['user_id' => (int) $account['id'], 'csrf' => bin2hex(random_bytes(32))];
    auditEvent('login.success', ['id' => (int) $account['id'], 'login' => $account['login']]);
    jsonResponse(['ok' => true]);
}

function logout(array $user): never
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }
    if (!hash_equals(csrfToken(), (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) {
        auditEvent('access.denied', $user, details: ['reason' => 'invalid_csrf']);
        jsonResponse(['error' => 'Invalid CSRF token'], 403);
    }
    auditEvent('logout', $user);
    $_SESSION = [];
    session_destroy();
    jsonResponse(['ok' => true]);
}

function me(array $user): never
{
    $unavailable = array_values(array_filter($user['data_schemas'], fn (string $schema) => !schemaExists($schema)));
    jsonResponse([
        'login' => $user['login'],
        'data_schema' => $user['data_schema'],
        'data_schemas' => $user['data_schemas'],
        'unavailable_data_schemas' => $unavailable,
        'can_view_protected' => $user['can_view_protected'],
        'csrf_token' => csrfToken(),
    ]);
}

function auditLog(array $user): never
{
    if (!$user['can_view_protected']) {
        auditEvent('access.denied', $user, details: ['reason' => 'audit_access_denied']);
        jsonResponse(['error' => 'Audit log access denied'], 403);
    }
    $offset = (string) ($_GET['offset'] ?? '0');
    $limit = (string) ($_GET['limit'] ?? '50');
    if (!ctype_digit($offset) || !ctype_digit($limit) || (int) $limit < 1 || (int) $limit > 100) {
        throw new InvalidArgumentException('Invalid offset or limit');
    }
    $where = [];
    $params = [];
    $event = trim((string) ($_GET['event'] ?? ''));
    if ($event !== '') {
        if (!preg_match('/^[a-z.]+$/', $event)) {
            throw new InvalidArgumentException('Invalid event');
        }
        $where[] = 'event = :event';
        $params['event'] = $event;
    }
    $login = trim((string) ($_GET['login'] ?? ''));
    if (strlen($login) > 100) {
        throw new InvalidArgumentException('Invalid login');
    }
    if ($login !== '') {
        $where[] = 'login ILIKE :login';
        $params['login'] = '%' . $login . '%';
    }
    foreach (['from_date' => '>=', 'to_date' => '<'] as $name => $operator) {
        if (($_GET[$name] ?? '') === '') {
            continue;
        }
        $date = dateParameter($name, '');
        $where[] = 'created_at ' . $operator . ' :' . $name . "::date" . ($name === 'to_date' ? " + INTERVAL '1 day'" : '');
        $params[$name] = $date;
    }
    $whereSql = $where ? ' WHERE ' . implode(' AND ', $where) : '';
    $pdo = db();
    $statement = $pdo->prepare('SELECT COUNT(*) FROM auth.audit_log' . $whereSql);
    $statement->execute($params);
    $total = (int) $statement->fetchColumn();
    $statement = $pdo->prepare('SELECT id, created_at, event, user_id, login, host(ip) AS ip, data_schema, entity, entity_id, details '
        . 'FROM auth.audit_log' . $whereSql . ' ORDER BY id DESC LIMIT ' . (int) $limit . ' OFFSET ' . (int) $offset);
    $statement->execute($params);
    $items = $statement->fetchAll();
    foreach ($items as &$item) {
        $item['details'] = json_decode($item['details'], true, flags: JSON_THROW_ON_ERROR);
    }
    jsonResponse([
        'items' => $items,
        'total' => $total,
        'events' => $pdo->query('SELECT DISTINCT event FROM auth.audit_log ORDER BY event')->fetchAll(PDO::FETCH_COLUMN),
    ]);
}

function jsonResponse(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    // Cache-Control is set globally in public/.htaccess.
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    exit;
}

function integerParameter(string $name): ?int
{
    $value = $_GET[$name] ?? null;
    if ($value === null || $value === '') {
        return null;
    }
    if (!ctype_digit((string) $value) || (int) $value < 1) {
        throw new InvalidArgumentException("Invalid parameter: {$name}");
    }
    return (int) $value;
}

function dateParameter(string $name, string $fallback): string
{
    $value = (string) ($_GET[$name] ?? $fallback);
    $date = DateTimeImmutable::createFromFormat('!Y-m-d', $value);
    if (!$date || $date->format('Y-m-d') !== $value) {
        throw new InvalidArgumentException("Invalid parameter: {$name}");
    }
    return $value;
}

function filters(bool $withPeriod = true, bool $canViewProtected = false): array
{
    $today = new DateTimeImmutable('today');
    $values = [
        'account_id' => integerParameter('account_id'),
        'currency_id' => integerParameter('currency_id'),
        'direction_id' => integerParameter('direction_id'),
        'action_type_id' => integerParameter('action_type_id'),
        'suboperation_l1_id' => integerParameter('suboperation_l1_id'),
        'suboperation_l2_id' => integerParameter('suboperation_l2_id'),
        'include_protected' => $canViewProtected && ($_GET['include_protected'] ?? '0') === '1',
    ];
    if ($withPeriod) {
        $values['from_date'] = dateParameter('from_date', $today->modify('-29 days')->format('Y-m-d'));
        $values['to_date'] = dateParameter('to_date', $today->format('Y-m-d'));
        if ($values['from_date'] > $values['to_date']) {
            throw new InvalidArgumentException('from_date must not be after to_date');
        }
    }
    return $values;
}

function filterSql(array $filters, array &$params, bool $withPeriod): string
{
    $where = [];
    $mapping = [
        'account_id' => 'a.account_id',
        'currency_id' => 'a.currency_id',
        'direction_id' => 'd.id',
        'action_type_id' => 'at.id',
        'suboperation_l1_id' => 's1.id',
        'suboperation_l2_id' => 's2.id',
    ];
    foreach ($mapping as $name => $column) {
        if ($filters[$name] !== null) {
            $where[] = "{$column} = :{$name}";
            $params[$name] = $filters[$name];
        }
    }
    if (!$filters['include_protected']) {
        $where[] = 'a.is_black = false';
    }
    if ($withPeriod) {
        $where[] = 'a.action_date >= :from_date';
        $where[] = "a.action_date < (:to_date::date + INTERVAL '1 day')";
        $params['from_date'] = $filters['from_date'];
        $params['to_date'] = $filters['to_date'];
    }
    return $where ? ' AND ' . implode(' AND ', $where) : '';
}

function joins(): string
{
    return <<<'SQL'
        JOIN accounts ac ON ac.id = a.account_id
        JOIN currencies c ON c.id = a.currency_id
        JOIN suboperations_l2 s2 ON s2.id = a.suboperation_id
        LEFT JOIN suboperations_l1 s1 ON s1.id = s2.suboperation_l1_id
        LEFT JOIN action_types at ON at.id = s1.action_type_id
        LEFT JOIN directions d ON d.id = at.direction_id
    SQL;
}

function lookups(): never
{
    $pdo = db();
    $queries = [
        'accounts' => 'SELECT id, name, currency_id FROM accounts ORDER BY name NULLS LAST, id',
        'currencies' => <<<'SQL'
            SELECT c.id, c.name, COALESCE(
                (SELECT cr.rate FROM currency_rates cr
                 WHERE cr.currency_id = c.id AND cr.rate IS NOT NULL
                 ORDER BY cr.rate_date DESC NULLS LAST, cr.id DESC LIMIT 1),
                CASE WHEN c.name = 'р.' THEN 1 END
            ) AS default_rate
            FROM currencies c ORDER BY c.name NULLS LAST, c.id
        SQL,
        'directions' => 'SELECT id, name, is_placeholder FROM directions ORDER BY name NULLS LAST, id',
        'action_types' => 'SELECT id, direction_id, name, is_placeholder FROM action_types ORDER BY name NULLS LAST, id',
        'suboperations_l1' => 'SELECT id, action_type_id, name, is_placeholder FROM suboperations_l1 ORDER BY name NULLS LAST, id',
        'suboperations_l2' => 'SELECT id, suboperation_l1_id, name, is_placeholder FROM suboperations_l2 ORDER BY name NULLS LAST, id',
    ];
    $result = [];
    foreach ($queries as $name => $sql) {
        $result[$name] = $pdo->query($sql)->fetchAll();
    }
    jsonResponse($result);
}

function referenceConfig(string $type): array
{
    $configs = [
        'accounts' => [
            'table' => 'accounts', 'fields' => ['name' => 'text', 'currency_id' => 'id', 'memo' => 'nullable_text'],
            'relations' => ['currency_id' => 'currencies'], 'order' => 'name NULLS LAST, id',
            'dependencies' => [['actions', 'account_id', 'операциях']],
        ],
        'currencies' => [
            'table' => 'currencies', 'fields' => ['name' => 'text', 'memo' => 'nullable_text'],
            'order' => 'name NULLS LAST, id',
            'dependencies' => [
                ['actions', 'currency_id', 'операциях'], ['accounts', 'currency_id', 'счетах'],
                ['currency_rates', 'currency_id', 'курсах'],
            ],
        ],
        'currency_rates' => [
            'table' => 'currency_rates',
            'fields' => ['currency_id' => 'id', 'rate_date' => 'datetime', 'rate' => 'decimal'],
            'relations' => ['currency_id' => 'currencies'], 'order' => 'rate_date DESC NULLS LAST, id DESC',
            'dependencies' => [],
        ],
        'directions' => [
            'table' => 'directions', 'fields' => ['name' => 'text', 'memo' => 'nullable_text'],
            'order' => 'name NULLS LAST, id', 'placeholder' => true,
            'dependencies' => [['action_types', 'direction_id', 'операциях справочника']],
        ],
        'action_types' => [
            'table' => 'action_types',
            'fields' => ['direction_id' => 'id', 'name' => 'text', 'memo' => 'nullable_text'],
            'relations' => ['direction_id' => 'directions'], 'order' => 'name NULLS LAST, id', 'placeholder' => true,
            'dependencies' => [['suboperations_l1', 'action_type_id', 'подоперациях 1']],
        ],
        'suboperations_l1' => [
            'table' => 'suboperations_l1',
            'fields' => ['action_type_id' => 'id', 'name' => 'text', 'memo' => 'nullable_text'],
            'relations' => ['action_type_id' => 'action_types'], 'order' => 'name NULLS LAST, id', 'placeholder' => true,
            'dependencies' => [['suboperations_l2', 'suboperation_l1_id', 'подоперациях 2']],
        ],
        'suboperations_l2' => [
            'table' => 'suboperations_l2',
            'fields' => ['suboperation_l1_id' => 'id', 'name' => 'text', 'memo' => 'nullable_text'],
            'relations' => ['suboperation_l1_id' => 'suboperations_l1'], 'order' => 'name NULLS LAST, id', 'placeholder' => true,
            'dependencies' => [['actions', 'suboperation_id', 'операциях']],
        ],
    ];
    if (!isset($configs[$type])) {
        throw new InvalidArgumentException('Unknown reference type');
    }
    return $configs[$type];
}

function references(string $type): never
{
    $config = referenceConfig($type);
    jsonResponse(db()->query("SELECT * FROM {$config['table']} ORDER BY {$config['order']}")->fetchAll());
}

function referenceBody(array $config): array
{
    $body = json_decode(file_get_contents('php://input'), true, flags: JSON_THROW_ON_ERROR);
    if (!is_array($body)) {
        throw new InvalidArgumentException('Invalid request body');
    }
    $values = [];
    foreach ($config['fields'] as $name => $type) {
        $value = $body[$name] ?? null;
        if ($type === 'text' || $type === 'nullable_text') {
            $value = trim((string) $value);
            if ($type === 'text' && $value === '') {
                throw new InvalidArgumentException("Поле {$name} обязательно");
            }
            $values[$name] = $value === '' ? null : $value;
        } elseif ($type === 'id') {
            if (!ctype_digit((string) $value) || (int) $value < 1) {
                throw new InvalidArgumentException("Invalid field: {$name}");
            }
            $values[$name] = (int) $value;
        } elseif ($type === 'decimal') {
            if (!is_numeric($value) || (float) $value <= 0) {
                throw new InvalidArgumentException("Invalid field: {$name}");
            }
            $values[$name] = number_format((float) $value, 4, '.', '');
        } elseif ($type === 'datetime') {
            $date = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', (string) $value);
            if (!$date || $date->format('Y-m-d\TH:i') !== $value) {
                throw new InvalidArgumentException("Invalid field: {$name}");
            }
            $values[$name] = $date->format('Y-m-d H:i:s');
        }
    }
    foreach ($config['relations'] ?? [] as $field => $table) {
        $statement = db()->prepare("SELECT 1 FROM {$table} WHERE id = :id");
        $statement->execute(['id' => $values[$field]]);
        if (!$statement->fetchColumn()) {
            throw new InvalidArgumentException("Unknown field value: {$field}");
        }
    }
    return $values;
}

function writeReference(array $user, string $type, ?int $id = null): never
{
    requireCsrf($user);
    $config = referenceConfig($type);
    $values = referenceBody($config);
    $columns = array_keys($values);
    $pdo = db();
    $pdo->beginTransaction();
    $old = null;
    if ($id !== null) {
        $statement = $pdo->prepare("SELECT * FROM {$config['table']} WHERE id = :id");
        $statement->execute(['id' => $id]);
        $old = $statement->fetch() ?: null;
    }
    if ($id === null) {
        $sql = "INSERT INTO {$config['table']} (" . implode(', ', $columns) . ') VALUES ('
            . implode(', ', array_map(fn (string $column) => ":{$column}", $columns)) . ') RETURNING id';
    } else {
        $sets = array_map(fn (string $column) => "{$column} = :{$column}", $columns);
        if (!empty($config['placeholder'])) {
            $sets[] = 'is_placeholder = false';
        }
        $sql = "UPDATE {$config['table']} SET " . implode(', ', $sets) . ' WHERE id = :id RETURNING id';
        $values['id'] = $id;
    }
    try {
        $statement = $pdo->prepare($sql);
        $statement->execute($values);
        $savedId = $statement->fetchColumn();
        if ($savedId === false) {
            $pdo->rollBack();
            jsonResponse(['error' => 'Запись не найдена'], 404);
        }
        $statement = $pdo->prepare("SELECT * FROM {$config['table']} WHERE id = :id");
        $statement->execute(['id' => $savedId]);
        $new = $statement->fetch();
        auditEvent('reference.' . ($id === null ? 'created' : 'updated'), $user, $type, (int) $savedId, compact('old', 'new'), pdo: $pdo);
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
    jsonResponse(['id' => (int) $savedId], $id === null ? 201 : 200);
}

function deleteReference(array $user, string $type, int $id): never
{
    requireCsrf($user);
    $config = referenceConfig($type);
    $pdo = db();
    $pdo->beginTransaction();
    $statement = $pdo->prepare("SELECT * FROM {$config['table']} WHERE id = :id");
    $statement->execute(['id' => $id]);
    $old = $statement->fetch();
    if (!$old) {
        $pdo->rollBack();
        jsonResponse(['error' => 'Запись не найдена'], 404);
    }
    $uses = [];
    foreach ($config['dependencies'] as [$table, $column, $label]) {
        $statement = $pdo->prepare("SELECT COUNT(*) FROM {$table} WHERE {$column} = :id");
        $statement->execute(['id' => $id]);
        $count = (int) $statement->fetchColumn();
        if ($count) {
            $uses[] = "{$label}: {$count}";
        }
    }
    if ($uses) {
        $pdo->rollBack();
        jsonResponse(['error' => 'Нельзя удалить запись: она используется (' . implode(', ', $uses) . ')'], 409);
    }
    try {
        $statement = $pdo->prepare("DELETE FROM {$config['table']} WHERE id = :id");
        $statement->execute(['id' => $id]);
        auditEvent('reference.deleted', $user, $type, $id, ['old' => $old], pdo: $pdo);
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
    jsonResponse(['ok' => true]);
}

function actionBody(): array
{
    $body = json_decode(file_get_contents('php://input'), true, flags: JSON_THROW_ON_ERROR);
    if (!is_array($body)) {
        throw new InvalidArgumentException('Invalid request body');
    }
    foreach (['account_id', 'currency_id', 'suboperation_id'] as $name) {
        if (!isset($body[$name]) || !ctype_digit((string) $body[$name]) || (int) $body[$name] < 1) {
            throw new InvalidArgumentException("Invalid field: {$name}");
        }
        $body[$name] = (int) $body[$name];
    }
    $date = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', (string) ($body['action_date'] ?? ''));
    if (!$date || $date->format('Y-m-d\TH:i') !== ($body['action_date'] ?? '')) {
        throw new InvalidArgumentException('Invalid field: action_date');
    }
    if (!isset($body['amount']) || !is_numeric($body['amount']) || (float) $body['amount'] <= 0) {
        throw new InvalidArgumentException('Invalid field: amount');
    }
    $exchangeRate = $body['exchange_rate'] ?? null;
    if ($exchangeRate !== null && $exchangeRate !== '' && (!is_numeric($exchangeRate) || (float) $exchangeRate <= 0)) {
        throw new InvalidArgumentException('Invalid field: exchange_rate');
    }
    $isDebit = filter_var($body['is_debit'] ?? null, FILTER_VALIDATE_BOOL, FILTER_NULL_ON_FAILURE);
    $isBlack = filter_var($body['is_black'] ?? false, FILTER_VALIDATE_BOOL, FILTER_NULL_ON_FAILURE);
    if ($isDebit === null || $isBlack === null) {
        throw new InvalidArgumentException('Invalid boolean field');
    }
    $posting = $body['posting'] ?? null;
    if ($posting !== null) {
        if (!is_array($posting)) {
            throw new InvalidArgumentException('Invalid field: posting');
        }
        foreach (['account_id', 'suboperation_id'] as $name) {
            if (!isset($posting[$name]) || !ctype_digit((string) $posting[$name]) || (int) $posting[$name] < 1) {
                throw new InvalidArgumentException("Invalid posting field: {$name}");
            }
            $posting[$name] = (int) $posting[$name];
        }
    }
    return [
        'account_id' => $body['account_id'],
        'currency_id' => $body['currency_id'],
        'suboperation_id' => $body['suboperation_id'],
        'action_date' => $date->format('Y-m-d H:i:s'),
        'amount' => number_format((float) $body['amount'], 2, '.', ''),
        'exchange_rate' => $exchangeRate === null || $exchangeRate === '' ? null : number_format((float) $exchangeRate, 4, '.', ''),
        'is_debit' => $isDebit,
        'memo' => trim((string) ($body['memo'] ?? '')) ?: null,
        'is_black' => $isBlack,
        '_posting' => $posting,
    ];
}

function writeAction(array $user, ?int $id = null): never
{
    requireCsrf($user);
    $values = actionBody();
    $posting = $values['_posting'];
    unset($values['_posting']);
    if ($id !== null && $posting !== null) {
        throw new InvalidArgumentException('Posting is only available for new operations');
    }
    if ($values['is_black'] && !$user['can_view_protected']) {
        auditEvent('access.denied', $user, 'actions', $id, ['reason' => 'protected_operation']);
        jsonResponse(['error' => 'Protected operation access denied'], 403);
    }
    $pdo = db();
    foreach (['accounts' => 'account_id', 'currencies' => 'currency_id', 'suboperations_l2' => 'suboperation_id'] as $table => $field) {
        $statement = $pdo->prepare("SELECT 1 FROM {$table} WHERE id = :id");
        $statement->execute(['id' => $values[$field]]);
        if (!$statement->fetchColumn()) {
            throw new InvalidArgumentException("Unknown field value: {$field}");
        }
    }
    if ($posting !== null) {
        foreach (['accounts' => 'account_id', 'suboperations_l2' => 'suboperation_id'] as $table => $field) {
            $statement = $pdo->prepare("SELECT 1 FROM {$table} WHERE id = :id");
            $statement->execute(['id' => $posting[$field]]);
            if (!$statement->fetchColumn()) {
                throw new InvalidArgumentException("Unknown posting field value: {$field}");
            }
        }
    }
    $values['is_debit'] = $values['is_debit'] ? 'true' : 'false';
    $values['is_black'] = $values['is_black'] ? 'true' : 'false';
    $pdo->beginTransaction();
    if ($id === null) {
        $sql = 'INSERT INTO actions (account_id, currency_id, suboperation_id, action_date, amount, '
            . 'exchange_rate, is_debit, memo, is_black) VALUES (:account_id, :currency_id, :suboperation_id, '
            . ':action_date, :amount, :exchange_rate, :is_debit, :memo, :is_black) RETURNING id';
    } else {
        $access = $pdo->prepare('SELECT * FROM actions WHERE id = :id');
        $access->execute(['id' => $id]);
        $action = $access->fetch();
        if (!$action) {
            $pdo->rollBack();
            jsonResponse(['error' => 'Operation not found'], 404);
        }
        if ((bool) $action['is_black'] && !$user['can_view_protected']) {
            $pdo->rollBack();
            auditEvent('access.denied', $user, 'actions', $id, ['reason' => 'protected_operation']);
            jsonResponse(['error' => 'Protected operation access denied'], 403);
        }
        $sql = 'UPDATE actions SET account_id = :account_id, currency_id = :currency_id, '
            . 'suboperation_id = :suboperation_id, action_date = :action_date, amount = :amount, '
            . 'exchange_rate = :exchange_rate, is_debit = :is_debit, memo = :memo, is_black = :is_black '
            . 'WHERE id = :id RETURNING id';
        $values['id'] = $id;
    }
    $old = $id === null ? null : $action;
    try {
        $statement = $pdo->prepare($sql);
        $statement->execute($values);
        $result = ['id' => (int) $statement->fetchColumn()];
        $saved = $pdo->prepare('SELECT * FROM actions WHERE id = :id');
        $saved->execute(['id' => $result['id']]);
        auditEvent('action.' . ($id === null ? 'created' : 'updated'), $user, 'actions', $result['id'], ['old' => $old, 'new' => $saved->fetch()], pdo: $pdo);
        if ($posting !== null) {
            $values['account_id'] = $posting['account_id'];
            $values['suboperation_id'] = $posting['suboperation_id'];
            $values['is_debit'] = $values['is_debit'] === 'true' ? 'false' : 'true';
            $statement->execute($values);
            $result['posting_id'] = (int) $statement->fetchColumn();
            $saved->execute(['id' => $result['posting_id']]);
            auditEvent('action.created', $user, 'actions', $result['posting_id'], ['old' => null, 'new' => $saved->fetch()], pdo: $pdo);
        }
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
    jsonResponse($result, $id === null ? 201 : 200);
}

function deleteAction(array $user, int $id): never
{
    requireCsrf($user);
    $pdo = db();
    $pdo->beginTransaction();
    $statement = $pdo->prepare('SELECT * FROM actions WHERE id = :id'
        . ($user['can_view_protected'] ? '' : ' AND is_black = false'));
    $statement->execute(['id' => $id]);
    $old = $statement->fetch();
    if (!$old) {
        $pdo->rollBack();
        auditEvent('access.denied', $user, 'actions', $id, ['reason' => 'not_found_or_protected']);
        jsonResponse(['error' => 'Operation not found or access denied'], 404);
    }
    try {
        $statement = $pdo->prepare('DELETE FROM actions WHERE id = :id');
        $statement->execute(['id' => $id]);
        auditEvent('action.deleted', $user, 'actions', $id, ['old' => $old], pdo: $pdo);
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
    jsonResponse(['ok' => true]);
}

function actions(array $user): never
{
    $filters = filters(true, $user['can_view_protected']);
    $flow = $_GET['flow'] ?? '';
    if (!in_array($flow, ['income', 'expense'], true)) {
        throw new InvalidArgumentException('flow must be income or expense');
    }
    $offset = (string) ($_GET['offset'] ?? '0');
    $limit = (string) ($_GET['limit'] ?? '100');
    if (!ctype_digit($offset) || !ctype_digit($limit) || (int) $limit < 1 || (int) $limit > 200) {
        throw new InvalidArgumentException('Invalid offset or limit');
    }
    $offset = (int) $offset;
    $limit = (int) $limit;

    $params = [];
    $where = filterSql($filters, $params, true);
    $base = ' FROM actions a ' . joins()
        . ' WHERE a.is_debit = ' . ($flow === 'income' ? 'TRUE' : 'FALSE') . $where;
    $total = null;
    if (($_GET['include_total'] ?? '0') === '1') {
        $statement = db()->prepare('SELECT COUNT(*)' . $base);
        $statement->execute($params);
        $total = (int) $statement->fetchColumn();
    }

    $page = 'SELECT a.id' . $base
        . ' ORDER BY a.action_date DESC, a.id DESC '
        . "LIMIT {$limit} OFFSET {$offset}";
    $sql = 'WITH page AS (' . $page . ') SELECT a.id, a.account_id, a.currency_id, a.suboperation_id, '
        . 'a.action_date, a.amount, a.exchange_rate, a.is_debit, a.memo, a.is_black, '
        . 'ac.name AS account, c.name AS currency, '
        . 'd.name AS direction, at.name AS action_type, s1.name AS suboperation_l1, '
        . 's2.name AS suboperation_l2, s2.is_placeholder AS suboperation_placeholder '
        . 'FROM page p JOIN actions a ON a.id = p.id ' . joins()
        . ' ORDER BY a.action_date DESC, a.id DESC';
    $statement = db()->prepare($sql);
    $statement->execute($params);
    $items = $statement->fetchAll();
    jsonResponse(['items' => $items, 'total' => $total]);
}

function summary(array $user): never
{
    $filters = filters(true, $user['can_view_protected']);
    $params = ['from_date' => $filters['from_date'], 'to_date' => $filters['to_date']];
    $where = filterSql($filters, $params, false);
    $base = ' FROM actions a ' . joins() . ' WHERE a.action_date < (:to_date::date + INTERVAL \'1 day\')' . $where;
    $measures = <<<'SQL'
        COALESCE(SUM(CASE WHEN a.action_date < :from_date THEN
            CASE WHEN a.is_debit THEN a.amount ELSE -a.amount END ELSE 0 END), 0) AS opening,
        COALESCE(SUM(CASE WHEN a.action_date >= :from_date AND a.is_debit THEN a.amount ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN a.action_date >= :from_date AND NOT a.is_debit THEN a.amount ELSE 0 END), 0) AS expense,
        COUNT(*) FILTER (WHERE a.action_date >= :from_date) AS operation_count
    SQL;

    $statement = db()->prepare('SELECT c.id AS currency_id, c.name AS currency, ' . $measures . $base
        . ' GROUP BY c.id, c.name ORDER BY c.name NULLS LAST, c.id');
    $statement->execute($params);
    $currencies = addBalances($statement->fetchAll());

    $statement = db()->prepare('SELECT d.id AS direction_id, COALESCE(d.name, \'Без направления\') AS direction, '
        . 'c.id AS currency_id, c.name AS currency, ' . $measures . $base
        . ' GROUP BY d.id, d.name, c.id, c.name ORDER BY d.name NULLS LAST, d.id, c.name NULLS LAST, c.id');
    $statement->execute($params);
    $directions = addBalances($statement->fetchAll());

    jsonResponse([
        'currencies' => $currencies,
        'directions' => $directions,
        'operation_count' => array_sum(array_column($currencies, 'operation_count')),
    ]);
}

function addBalances(array $rows): array
{
    foreach ($rows as &$row) {
        $opening = (float) $row['opening'];
        $income = (float) $row['income'];
        $expense = (float) $row['expense'];
        $row['current'] = number_format($income - $expense, 2, '.', '');
        $row['closing'] = number_format($opening + $income - $expense, 2, '.', '');
    }
    return $rows;
}

loadEnv(dirname(__DIR__) . '/.env');
startAppSession();
