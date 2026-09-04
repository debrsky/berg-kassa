<?php

declare(strict_types=1);

// Test-only writer: hold an uncommitted protection change until the API is blocked.
require dirname(__DIR__, 2) . '/src/bootstrap.php';
useDataSchema($argv[1]);
$pdo = db();
$pdo->beginTransaction();
try {
    $statement = $pdo->prepare('UPDATE actions SET is_black = true WHERE id = :id');
    $statement->execute(['id' => $argv[2]]);
    if ($statement->rowCount() !== 1) throw new RuntimeException('Missing test operation');
    echo "READY\n";
    fflush(STDOUT);
    if (trim((string) fgets(STDIN)) !== 'wait') throw new RuntimeException('Expected wait');
    $deadline = microtime(true) + 10;
    do {
        $pdo->query('SELECT pg_stat_clear_snapshot()')->fetchColumn();
        $blocked = $pdo->query('SELECT EXISTS (SELECT 1 FROM pg_stat_activity '
            . 'WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid)))')->fetchColumn();
        if ($blocked) break;
        usleep(50_000);
    } while (microtime(true) < $deadline);
    if (!$blocked) throw new RuntimeException('API did not wait for the test row');
    echo "BLOCKED\n";
    fflush(STDOUT);
    if (trim((string) fgets(STDIN)) !== 'commit') throw new RuntimeException('Expected commit');
    $pdo->commit();
} finally {
    if ($pdo->inTransaction()) $pdo->rollBack();
}
