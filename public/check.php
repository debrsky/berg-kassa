<?php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

try {
    require dirname(__DIR__) . '/src/app.php';
    $database = db()->query('SELECT current_database()')->fetchColumn();
    echo json_encode([
        'ok' => true,
        'pdo_pgsql' => extension_loaded('pdo_pgsql'),
        'database' => $database,
    ], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
} catch (Throwable $error) {
    http_response_code(500);
    $required = [
        'LOCAL_PGSQL_HOST',
        'LOCAL_PGSQL_PORT',
        'LOCAL_PGSQL_USER',
        'LOCAL_PGSQL_PASSWORD',
        'LOCAL_PGSQL_DATABASE',
    ];
    echo json_encode([
        'ok' => false,
        'pdo_pgsql' => extension_loaded('pdo_pgsql'),
        'error_type' => $error::class,
        'missing_settings' => array_values(array_filter($required, fn (string $name) => getenv($name) === false)),
    ], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
}
