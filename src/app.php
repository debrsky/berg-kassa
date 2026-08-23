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

function selectDataSchema(array $user): never
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }
    if (!hash_equals(csrfToken(), (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) {
        jsonResponse(['error' => 'Invalid CSRF token'], 403);
    }
    $body = json_decode(file_get_contents('php://input'), true);
    $schema = (string) ($body['data_schema'] ?? '');
    if (!in_array($schema, $user['data_schemas'], true)) {
        jsonResponse(['error' => 'Schema access denied'], 403);
    }
    if (!schemaExists($schema)) {
        throw new DataSchemaNotFound($schema);
    }
    $_SESSION['data_schema'] = $schema;
    jsonResponse(['ok' => true]);
}

function login(): never
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }
    $now = time();
    $attempts = $_SESSION['login_attempts'] ?? [];
    $attempts = array_values(array_filter($attempts, fn (int $time) => $time > $now - 60));
    if (count($attempts) >= 5) {
        jsonResponse(['error' => 'Слишком много попыток. Повторите через минуту.'], 429);
    }
    $body = json_decode(file_get_contents('php://input'), true);
    $login = trim((string) ($body['login'] ?? ''));
    $password = (string) ($body['password'] ?? '');
    $statement = db()->prepare(
        'SELECT id, password_hash FROM auth.users WHERE lower(login) = lower(:login) AND is_active'
    );
    $statement->execute(['login' => $login]);
    $account = $statement->fetch();
    if (!$account || !password_verify($password, $account['password_hash'])) {
        $attempts[] = $now;
        $_SESSION['login_attempts'] = $attempts;
        usleep(250_000);
        jsonResponse(['error' => 'Неверный логин или пароль'], 401);
    }
    session_regenerate_id(true);
    $_SESSION = ['user_id' => (int) $account['id'], 'csrf' => bin2hex(random_bytes(32))];
    jsonResponse(['ok' => true]);
}

function logout(): never
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }
    if (!hash_equals(csrfToken(), (string) ($_SERVER['HTTP_X_CSRF_TOKEN'] ?? ''))) {
        jsonResponse(['error' => 'Invalid CSRF token'], 403);
    }
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

function jsonResponse(mixed $data, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
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
        'currencies' => 'SELECT id, name FROM currencies ORDER BY name NULLS LAST, id',
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
    $sql = 'WITH page AS (' . $page . ') SELECT a.id, a.suboperation_id, a.action_date, '
        . 'a.amount, a.exchange_rate, a.memo, a.is_black, ac.name AS account, c.name AS currency, '
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
