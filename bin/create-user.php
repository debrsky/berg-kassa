<?php

declare(strict_types=1);

require dirname(__DIR__) . '/src/bootstrap.php';

initAuth(db());

if ($argc === 1) {
    echo "Auth tables initialized.\n";
    exit(0);
}

if ($argc < 3 || $argc > 4) {
    fwrite(STDERR, "Usage: NEW_USER_PASSWORD=... php bin/create-user.php LOGIN SCHEMA[,SCHEMA...] [protected:0|1]\n");
    exit(1);
}

[$script, $login, $schemaArgument] = $argv;
$schemas = array_values(array_unique(array_filter(array_map('trim', explode(',', $schemaArgument)))));
$protectedArgument = $argv[3] ?? '0';
$password = getenv('NEW_USER_PASSWORD');

if (!in_array($protectedArgument, ['0', '1'], true)) {
    throw new InvalidArgumentException('protected must be 0 or 1');
}
$protected = $protectedArgument === '1';
if (!$schemas || array_filter($schemas, fn (string $schema) => !preg_match('/^[a-z_][a-z0-9_]*$/', $schema))) {
    throw new InvalidArgumentException('Invalid schema list');
}
if (trim($login) === '') {
    throw new InvalidArgumentException('Login must not be empty');
}
if ($password === false || $password === '') {
    throw new InvalidArgumentException('NEW_USER_PASSWORD must not be empty');
}

$pdo = db();
$pdo->beginTransaction();
$passwordHash = password_hash($password, PASSWORD_ARGON2ID);
if ($passwordHash === false) {
    throw new RuntimeException('Unable to hash password');
}
$values = [
    'login' => trim($login),
    'password_hash' => $passwordHash,
    'data_schema' => implode(',', $schemas),
    'can_view_protected' => $protected ? '1' : '0',
];
$statement = $pdo->prepare(<<<'SQL'
    INSERT INTO auth.users (login, password_hash, data_schema, can_view_protected)
    VALUES (:login, :password_hash, string_to_array(:data_schema, ','), :can_view_protected)
    ON CONFLICT (lower(login)) DO UPDATE SET
        login = EXCLUDED.login, password_hash = EXCLUDED.password_hash,
        data_schema = EXCLUDED.data_schema,
        can_view_protected = EXCLUDED.can_view_protected, is_active = true
    RETURNING id
SQL);
$statement->execute($values);
$pdo->commit();

echo "User saved.\n";
