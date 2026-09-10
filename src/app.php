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

function booleanParameter(string $name): ?bool
{
    $value = $_GET[$name] ?? null;
    if ($value === null || $value === '') return null;
    if (!in_array($value, ['0', '1'], true)) {
        throw new InvalidArgumentException("Invalid parameter: {$name}");
    }
    return $value === '1';
}

function filters(bool $withPeriod = true, bool $canViewProtected = false, string $checkPrefix = ''): array
{
    $memo = $_GET['memo'] ?? '';
    if (!is_string($memo) || strlen($memo) > 2000) {
        throw new InvalidArgumentException('Invalid parameter: memo');
    }
    $today = new DateTimeImmutable('today');
    $values = [
        'memo' => $memo,
        'account_id' => integerParameter('account_id'),
        'currency_id' => integerParameter('currency_id'),
        'direction_id' => integerParameter('direction_id'),
        'action_type_id' => integerParameter('action_type_id'),
        'suboperation_l1_id' => integerParameter('suboperation_l1_id'),
        'suboperation_l2_id' => integerParameter('suboperation_l2_id'),
        'checked_user' => booleanParameter($checkPrefix . 'checked_user'),
        'checked_superuser' => booleanParameter($checkPrefix . 'checked_superuser'),
        'include_protected' => $canViewProtected && ($_GET['include_protected'] ?? '0') === '1',
    ];
    if ($withPeriod) {
        $values['from_date'] = (($_GET['from_date'] ?? null) === '') ? '-infinity' : dateParameter('from_date', $today->modify('-29 days')->format('Y-m-d'));
        $values['to_date'] = (($_GET['to_date'] ?? null) === '') ? 'infinity' : dateParameter('to_date', $today->format('Y-m-d'));
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
    foreach (['checked_user' => 'is_checked_user', 'checked_superuser' => 'is_checked_superuser'] as $name => $column) {
        if ($filters[$name] !== null) {
            $where[] = "a.{$column} = :{$name}";
            $params[$name] = $filters[$name] ? 'true' : 'false';
        }
    }
    if (($filters['memo'] ?? '') !== '') {
        $where[] = "a.memo ILIKE :memo ESCAPE '!'";
        $params['memo'] = '%' . strtr($filters['memo'], ['!' => '!!', '%' => '!%', '_' => '!_']) . '%';
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
        'directions' => 'SELECT id, name, memo, is_placeholder FROM directions ORDER BY name NULLS LAST, id',
        'action_types' => 'SELECT id, direction_id, name, memo, is_placeholder FROM action_types ORDER BY name NULLS LAST, id',
        'suboperations_l1' => 'SELECT id, action_type_id, name, memo, is_placeholder FROM suboperations_l1 ORDER BY name NULLS LAST, id',
        'suboperations_l2' => 'SELECT id, suboperation_l1_id, name, memo, is_placeholder FROM suboperations_l2 ORDER BY name NULLS LAST, id',
    ];
    $result = [];
    foreach ($queries as $name => $sql) {
        $result[$name] = $pdo->query($sql)->fetchAll();
    }
    jsonResponse($result);
}

require_once __DIR__ . '/auth.php';
require_once __DIR__ . '/references.php';
require_once __DIR__ . '/operations.php';
