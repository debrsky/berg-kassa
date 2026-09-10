<?php

declare(strict_types=1);

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
        DO $$
        DECLARE data_schema_name text;
        BEGIN
            FOR data_schema_name IN
                SELECT table_schema FROM information_schema.tables WHERE table_name = 'actions'
            LOOP
                EXECUTE format('ALTER TABLE %I.actions ADD COLUMN IF NOT EXISTS is_checked_user boolean NOT NULL DEFAULT false', data_schema_name);
                EXECUTE format('ALTER TABLE %I.actions ADD COLUMN IF NOT EXISTS is_checked_superuser boolean NOT NULL DEFAULT false', data_schema_name);
            END LOOP;
        END $$;
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
    if ($user['can_view_protected']) {
        $user['data_schemas'] = db()->query(<<<'SQL'
            SELECT n.nspname
            FROM pg_namespace n
            WHERE EXISTS (
                SELECT 1 FROM information_schema.tables t
                WHERE t.table_schema = n.nspname AND t.table_name = 'actions'
            )
            ORDER BY n.nspname
        SQL)->fetchAll(PDO::FETCH_COLUMN);
    }
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

function requireProtectedAccess(array $user, string $reason): void
{
    if (!$user['can_view_protected']) {
        auditEvent('access.denied', $user, details: ['reason' => $reason]);
        jsonResponse(['error' => 'Protected access required'], 403);
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
        'id' => $user['id'],
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
    requireProtectedAccess($user, 'audit_access_denied');
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

function users(array $actor, ?int $id = null): never
{
    requireProtectedAccess($actor, 'users_access_denied');
    if ($_SERVER['REQUEST_METHOD'] === 'GET' && $id === null) {
        $items = db()->query(
            'SELECT id, login, to_json(data_schema)::text AS data_schemas_json, can_view_protected, is_active, created_at '
            . 'FROM auth.users ORDER BY lower(login)'
        )->fetchAll();
        foreach ($items as &$item) {
            $item['id'] = (int) $item['id'];
            $item['data_schemas'] = json_decode($item['data_schemas_json'], true, flags: JSON_THROW_ON_ERROR);
            $item['can_view_protected'] = (bool) $item['can_view_protected'];
            $item['is_active'] = (bool) $item['is_active'];
            unset($item['data_schemas_json']);
        }
        jsonResponse(['items' => $items]);
    }
    if (($id === null && $_SERVER['REQUEST_METHOD'] !== 'POST') || ($id !== null && !in_array($_SERVER['REQUEST_METHOD'], ['PUT', 'DELETE'], true))) {
        jsonResponse(['error' => 'Method not allowed'], 405);
    }
    requireCsrf($actor);
    if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
        if ($id === (int) $actor['id']) {
            throw new InvalidArgumentException('Нельзя удалить собственную учётную запись');
        }
        $pdo = db();
        $pdo->beginTransaction();
        try {
            $statement = $pdo->prepare('SELECT id, login, data_schema, can_view_protected, is_active FROM auth.users WHERE id = :id FOR UPDATE');
            $statement->execute(['id' => $id]);
            $old = $statement->fetch();
            if (!$old) {
                $pdo->rollBack();
                jsonResponse(['error' => 'User not found'], 404);
            }
            $statement = $pdo->prepare('DELETE FROM auth.users WHERE id = :id');
            $statement->execute(['id' => $id]);
            auditEvent('user.deleted', $actor, 'users', $id, ['old' => $old], pdo: $pdo);
            $pdo->commit();
        } catch (Throwable $error) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $error;
        }
        jsonResponse(['ok' => true]);
    }
    $body = json_decode(file_get_contents('php://input'), true, flags: JSON_THROW_ON_ERROR);
    $login = trim((string) ($body['login'] ?? ''));
    $schemas = array_values(array_unique(array_map('trim', is_array($body['data_schemas'] ?? null) ? $body['data_schemas'] : [])));
    $password = (string) ($body['password'] ?? '');
    $protected = ($body['can_view_protected'] ?? false) === true;
    $active = ($body['is_active'] ?? true) === true;
    if ($login === '' || strlen($login) > 100 || !$schemas
        || array_filter($schemas, fn ($schema) => !is_string($schema) || !preg_match('/^[a-z_][a-z0-9_]*$/', $schema))) {
        throw new InvalidArgumentException('Invalid user fields');
    }
    if (($id === null || $password !== '') && strlen($password) < 12) {
        throw new InvalidArgumentException('Password must contain at least 12 characters');
    }
    if ($id === (int) $actor['id'] && (!$protected || !$active)) {
        throw new InvalidArgumentException('Нельзя отозвать собственную административную роль или отключить свою учётную запись');
    }
    $duplicate = db()->prepare('SELECT 1 FROM auth.users WHERE lower(login) = lower(:login)' . ($id === null ? '' : ' AND id <> :id'));
    $duplicate->execute(array_filter(['login' => $login, 'id' => $id], fn ($value) => $value !== null));
    if ($duplicate->fetchColumn()) {
        jsonResponse(['error' => 'Пользователь с таким логином уже существует'], 409);
    }
    $pdo = db();
    $pdo->beginTransaction();
    $old = null;
    if ($id !== null) {
        $statement = db()->prepare('SELECT id, login, data_schema, can_view_protected, is_active FROM auth.users WHERE id = :id FOR UPDATE');
        $statement->execute(['id' => $id]);
        $old = $statement->fetch();
        if (!$old) {
            $pdo->rollBack();
            jsonResponse(['error' => 'User not found'], 404);
        }
    }
    $params = [
        'login' => $login,
        'data_schema' => '{' . implode(',', $schemas) . '}',
        'can_view_protected' => $protected ? '1' : '0',
        'is_active' => $active ? '1' : '0',
    ];
    if ($id === null) {
        $params['password_hash'] = password_hash($password, PASSWORD_ARGON2ID);
        $statement = db()->prepare(
            'INSERT INTO auth.users (login, password_hash, data_schema, can_view_protected, is_active) '
            . 'VALUES (:login, :password_hash, :data_schema, :can_view_protected, :is_active) RETURNING id'
        );
    } else {
        $params['id'] = $id;
        $passwordSql = '';
        if ($password !== '') {
            $params['password_hash'] = password_hash($password, PASSWORD_ARGON2ID);
            $passwordSql = ', password_hash = :password_hash';
        }
        $statement = db()->prepare(
            'UPDATE auth.users SET login = :login, data_schema = :data_schema, can_view_protected = :can_view_protected, '
            . 'is_active = :is_active' . $passwordSql . ' WHERE id = :id RETURNING id'
        );
    }
    try {
        $statement->execute($params);
        $savedId = (int) $statement->fetchColumn();
        $new = compact('login', 'schemas', 'protected', 'active');
        auditEvent('user.' . ($id === null ? 'created' : 'updated'), $actor, 'users', $savedId, ['old' => $old, 'new' => $new], pdo: $pdo);
        $pdo->commit();
    } catch (Throwable $error) {
        $pdo->rollBack();
        throw $error;
    }
    jsonResponse(['id' => $savedId], $id === null ? 201 : 200);
}
