<?php

declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';

$days = filter_var($argv[1] ?? '180', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
if ($days === false) {
    fwrite(STDERR, "Usage: php bin/prune-audit-log.php [retention-days]\n");
    exit(1);
}

$pdo = db();
$pdo->beginTransaction();
$pdo->exec("SET LOCAL app.audit_maintenance = 'on'");
$statement = $pdo->prepare("DELETE FROM auth.audit_log WHERE created_at < now() - (:days * INTERVAL '1 day')");
$statement->execute(['days' => $days]);
$pdo->commit();
echo "Deleted {$statement->rowCount()} audit events.\n";
