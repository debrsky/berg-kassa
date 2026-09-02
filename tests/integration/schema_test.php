<?php

declare(strict_types=1);

require dirname(__DIR__, 2) . '/src/app.php';

$schema = env('LOCAL_PGSQL_SCHEMA');
initAuth(db());
useDataSchema($schema);
$pdo = db();
$passed = 0;
$check = function (bool $condition, string $message) use (&$passed): void {
    if (!$condition) {
        throw new RuntimeException($message);
    }
    $passed++;
};

$required = [
    'actions' => ['id', 'account_id', 'currency_id', 'suboperation_id', 'action_date', 'amount', 'exchange_rate', 'is_debit', 'memo', 'is_black'],
    'accounts' => ['id', 'name', 'currency_id'],
    'currencies' => ['id', 'name'],
    'currency_rates' => ['id', 'currency_id', 'rate_date', 'rate'],
    'directions' => ['id', 'name', 'is_placeholder'],
    'action_types' => ['id', 'direction_id', 'name', 'is_placeholder'],
    'suboperations_l1' => ['id', 'action_type_id', 'name', 'is_placeholder'],
    'suboperations_l2' => ['id', 'suboperation_l1_id', 'name', 'is_placeholder'],
];
foreach ($required as $table => $columns) {
    $statement = $pdo->prepare('SELECT column_name FROM information_schema.columns WHERE table_schema = :schema AND table_name = :table');
    $statement->execute(['schema' => $schema, 'table' => $table]);
    $actual = $statement->fetchAll(PDO::FETCH_COLUMN);
    $check(!array_diff($columns, $actual), "Missing columns in {$table}");
}

$statement = $pdo->prepare("SELECT column_name FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'audit_log'");
$statement->execute();
$auditColumns = $statement->fetchAll(PDO::FETCH_COLUMN);
$check(!array_diff(['created_at', 'event', 'user_id', 'login', 'ip', 'data_schema', 'entity', 'entity_id', 'details'], $auditColumns), 'Missing audit log columns');
$pdo->beginTransaction();
auditEvent('test.event', details: ['test' => true], pdo: $pdo);
$check($pdo->query("SELECT details->>'test' FROM auth.audit_log WHERE event = 'test.event' ORDER BY id DESC LIMIT 1")->fetchColumn() === 'true', 'Audit event is stored');
$pdo->rollBack();
$pdo->beginTransaction();
auditEvent('test.event', pdo: $pdo);
try {
    $pdo->exec("UPDATE auth.audit_log SET event = 'changed' WHERE event = 'test.event'");
    $appendOnly = false;
} catch (PDOException) {
    $appendOnly = true;
}
$pdo->rollBack();
$check($appendOnly, 'Audit log is append-only');

$index = $pdo->prepare("SELECT COUNT(*) FROM pg_indexes WHERE schemaname = :schema AND tablename = 'actions' AND indexdef ILIKE '%is_debit%' AND indexdef ILIKE '%action_date%' AND indexdef ILIKE '%id%'");
$index->execute(['schema' => $schema]);
$check((int) $index->fetchColumn() > 0, 'Missing actions paging index');

$orphans = [
    'actions/account' => 'SELECT COUNT(*) FROM actions a LEFT JOIN accounts p ON p.id=a.account_id WHERE p.id IS NULL',
    'actions/currency' => 'SELECT COUNT(*) FROM actions a LEFT JOIN currencies p ON p.id=a.currency_id WHERE p.id IS NULL',
    'actions/suboperation' => 'SELECT COUNT(*) FROM actions a LEFT JOIN suboperations_l2 p ON p.id=a.suboperation_id WHERE p.id IS NULL',
    'action_types/direction' => 'SELECT COUNT(*) FROM action_types a LEFT JOIN directions p ON p.id=a.direction_id WHERE a.direction_id IS NOT NULL AND p.id IS NULL',
    'suboperations_l1/action_type' => 'SELECT COUNT(*) FROM suboperations_l1 a LEFT JOIN action_types p ON p.id=a.action_type_id WHERE a.action_type_id IS NOT NULL AND p.id IS NULL',
    'suboperations_l2/suboperations_l1' => 'SELECT COUNT(*) FROM suboperations_l2 a LEFT JOIN suboperations_l1 p ON p.id=a.suboperation_l1_id WHERE a.suboperation_l1_id IS NOT NULL AND p.id IS NULL',
];
foreach ($orphans as $relation => $sql) {
    $check((int) $pdo->query($sql)->fetchColumn() === 0, "Orphan records: {$relation}");
}

echo "Integration/schema: {$passed} passed\n";
