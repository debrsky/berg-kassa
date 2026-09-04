<?php

declare(strict_types=1);

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
            $values[$name] = positiveDecimal($value, 12, 4, $name);
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
    requireProtectedAccess($user, 'reference_write_denied');
    requireCsrf($user);
    $config = referenceConfig($type);
    $values = referenceBody($config);
    $columns = array_keys($values);
    $pdo = db();
    $pdo->beginTransaction();
    $old = null;
    if ($id !== null) {
        $statement = $pdo->prepare("SELECT * FROM {$config['table']} WHERE id = :id FOR UPDATE");
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
    requireProtectedAccess($user, 'reference_write_denied');
    requireCsrf($user);
    $config = referenceConfig($type);
    $pdo = db();
    $pdo->beginTransaction();
    $statement = $pdo->prepare("SELECT * FROM {$config['table']} WHERE id = :id FOR UPDATE");
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
