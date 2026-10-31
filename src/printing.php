<?php

declare(strict_types=1);

const PRINT_WARNING_COUNT = 500;
const PRINT_MAX_COUNT = 2000;

function printVolumeState(int $count, bool $confirmed): string
{
    if ($count > PRINT_MAX_COUNT) return 'blocked';
    if ($count > PRINT_WARNING_COUNT && !$confirmed) return 'confirm';
    return 'ready';
}

function printEscape(mixed $value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

// PostgreSQL numeric values remain decimal strings, including very large balances.
function printMoney(?string $value): string
{
    if ($value === null) return '—';
    [$whole, $fraction] = array_pad(explode('.', $value, 2), 2, '');
    return preg_replace('/\B(?=(\d{3})+(?!\d))/', ' ', $whole) . ',' . str_pad($fraction, 2, '0');
}

// Width in digit cells, calculated without converting decimal strings to float.
function printAmountCharacters(array $items): int
{
    $characters = 8;
    foreach ($items as $item) {
        if ($item['amount'] !== null) $characters = max($characters, strlen(printMoney($item['amount'])));
    }
    return $characters;
}

// Only explicitly applied classification filters receive a header reference.
function printClassificationMarkers(array $filters): array
{
    $markers = [];
    foreach (['direction' => '①', 'action_type' => '②', 'suboperation_l1' => '③', 'suboperation_l2' => '④'] as $field => $symbol) {
        if (($filters[$field . '_id'] ?? null) !== null) $markers[$field] = $symbol;
    }
    return $markers;
}

function printReportData(array $user): array
{
    $filters = filters(true, $user['can_view_protected']);
    // Only flow-specific check filters belong to the combined report.
    $filters['checked_user'] = $filters['checked_superuser'] = null;
    $params = [];
    $where = filterSql($filters, $params, true) . flowCheckSql($params);
    $base = ' FROM actions a ' . joins() . ' WHERE TRUE' . $where;
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $pdo->exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
        $statement = $pdo->prepare('SELECT COUNT(*)' . $base);
        $statement->execute($params);
        $count = (int) $statement->fetchColumn();
        $state = printVolumeState($count, ($_GET['confirmed'] ?? '') === '1');
        $report = ['count' => $count, 'state' => $state, 'filters' => $filters];
        if ($state === 'ready') {
            $statement = $pdo->prepare('SELECT a.id, a.action_date, a.amount, a.memo, a.is_debit, a.is_black, '
                . 'a.is_checked_user, a.is_checked_superuser, ac.name AS account, c.name AS currency, '
                . 'd.name AS direction, at.name AS action_type, s1.name AS suboperation_l1, '
                . 's2.name AS suboperation_l2, s2.id AS suboperation_id, s2.is_placeholder '
                . $base . ' ORDER BY a.action_date DESC, a.id DESC LIMIT ' . (PRINT_MAX_COUNT + 1));
            $statement->execute($params);
            $report['items'] = $statement->fetchAll();
            $report['summary'] = actionSummaryData($user, $filters);
            if (count($report['items']) !== $count || $report['summary']['operation_count'] !== $count) {
                throw new RuntimeException('Inconsistent print report');
            }
        }
        $report['labels'] = [];
        $classificationMarkers = printClassificationMarkers($filters);
        foreach ([
            'account_id' => ['accounts', 'Счёт'], 'currency_id' => ['currencies', 'Валюта'],
            'direction_id' => ['directions', 'Направление'], 'action_type_id' => ['action_types', 'Операция'],
            'suboperation_l1_id' => ['suboperations_l1', 'Подоперация 1'],
            'suboperation_l2_id' => ['suboperations_l2', 'Подоперация 2'],
        ] as $key => [$table, $label]) {
            if ($filters[$key] === null) continue;
            $statement = $pdo->prepare("SELECT name FROM {$table} WHERE id = :id");
            $statement->execute(['id' => $filters[$key]]);
            $symbol = $classificationMarkers[substr($key, 0, -3)] ?? null;
            $report['labels'][] = ($symbol === null ? '' : $symbol . ' ') . $label . ': ' . ($statement->fetchColumn() ?: 'ID: ' . $filters[$key]);
        }
        if ($filters['memo'] !== '') $report['labels'][] = 'Примечание содержит: ' . $filters['memo'];
        $report['labels'][] = $filters['include_protected'] ? 'Обычные и защищённые' : 'Только обычные';
        foreach (['income' => 'Приход', 'expense' => 'Расход'] as $flow => $label) {
            foreach (['checked_user' => 'пользователя', 'checked_superuser' => 'администратора'] as $key => $owner) {
                $value = booleanParameter("{$flow}_{$key}");
                if ($value !== null) $report['labels'][] = "{$label}, отметка {$owner}: " . ($value ? 'поставлена' : 'не поставлена');
            }
        }
        $pdo->commit();
        return $report;
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
}

function printReportPage(array $user): never
{
    header('Cache-Control: no-store');
    header('Content-Type: text/html; charset=utf-8');
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        header('Allow: GET');
        jsonResponse(['error' => 'Method not allowed'], 405);
    }
    // Do not silently print another schema after a change in a different tab.
    $schemaMismatch = ($_GET['schema'] ?? null) !== $user['data_schema'];
    $report = null;
    if (!$schemaMismatch) {
        useDataSchema($user['data_schema']);
        $report = printReportData($user);
    }
    $confirmation = ['schema' => $user['data_schema'], 'confirmed' => '1'];
    if ($report) {
        foreach ($report['filters'] as $key => $value) {
            if (in_array($key, ['checked_user', 'checked_superuser'], true)) continue;
            $confirmation[$key] = match ($value) {
                '-infinity', 'infinity', null => '', true => '1', false => '0', default => (string) $value,
            };
        }
        foreach (['income', 'expense'] as $flow) {
            foreach (['checked_user', 'checked_superuser'] as $key) {
                $value = booleanParameter("{$flow}_{$key}");
                if ($value !== null) $confirmation["{$flow}_{$key}"] = $value ? '1' : '0';
            }
        }
    }
    require __DIR__ . '/print-template.php';
    exit;
}
