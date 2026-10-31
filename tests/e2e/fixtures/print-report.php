<?php

declare(strict_types=1);

require dirname(__DIR__, 3) . '/src/app.php';
require dirname(__DIR__, 3) . '/src/printing.php';

// Synthetic layout fixture; no environment, session, credentials or database needed.
$user = ['data_schema' => 'test'];
$schemaMismatch = false;
$confirmation = [];
$item = [
    'id' => 123, 'action_date' => '2026-01-15 12:00:00', 'account' => 'Основная касса',
    'currency' => 'р.', 'direction' => 'Направление', 'action_type' => 'Операция',
    'suboperation_l1' => 'Уровень 1', 'suboperation_l2' => 'Уровень 2',
    'suboperation_id' => 1, 'is_placeholder' => false, 'is_debit' => true,
    'is_black' => true, 'is_checked_user' => true, 'is_checked_superuser' => false,
    'amount' => '99999999999999999.99', 'memo' => 'Короткое примечание',
];
$longMemo = str_repeat('Длинное примечание без сокращений. ', 25) . "\n" . str_repeat('НеразрывноеСлово', 20) . ' КОНЕЦ ПРИМЕЧАНИЯ';
$report = [
    'state' => 'ready', 'count' => 2,
    'filters' => ['from_date' => '2026-01-01', 'to_date' => '2026-01-31'],
    'labels' => ['Только тестовые данные'],
    'items' => [$item, array_replace($item, ['id' => 124, 'is_debit' => false, 'is_black' => false,
        'is_checked_user' => false, 'is_checked_superuser' => true, 'memo' => $longMemo])],
    'summary' => ['currencies' => [[
        'currency' => 'р.', 'opening' => '-99999999999999999.99',
        'income' => '99999999999999999.99', 'expense' => '99999999999999999.99',
        'current' => '0.00', 'closing' => '-99999999999999999.99',
    ]]],
];
$mode = $argv[1] ?? '';
$selected = match ($mode) {
    'filtered' => ['direction_id', 'action_type_id', 'suboperation_l1_id', 'suboperation_l2_id'],
    'partial' => ['direction_id', 'suboperation_l1_id'],
    default => [],
};
$report['filters'] += array_fill_keys($selected, 1);
foreach (['direction_id' => '① Направление: Направление', 'action_type_id' => '② Операция: Операция',
    'suboperation_l1_id' => '③ Подоперация 1: Уровень 1', 'suboperation_l2_id' => '④ Подоперация 2: Уровень 2'] as $key => $label) {
    if (in_array($key, $selected, true)) $report['labels'][] = $label;
}
require dirname(__DIR__, 3) . '/src/print-template.php';
