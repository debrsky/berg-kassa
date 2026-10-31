<?php

declare(strict_types=1);

require dirname(__DIR__, 2) . '/src/bootstrap.php';
require dirname(__DIR__, 2) . '/src/printing.php';

$pdo = db();
// Session-local synthetic tables: no writes to any working schema or real records.
$pdo->exec('SET search_path TO pg_temp, pg_catalog');
$pdo->exec(<<<'SQL'
    CREATE TEMP TABLE accounts AS SELECT 1 AS id, 'Тестовый счёт'::text AS name;
    CREATE TEMP TABLE currencies AS SELECT 1 AS id, 'ТЕСТ'::text AS name;
    CREATE TEMP TABLE directions AS SELECT 1 AS id, 'Направление'::text AS name;
    CREATE TEMP TABLE action_types AS SELECT 1 AS id, 1 AS direction_id, 'Операция'::text AS name;
    CREATE TEMP TABLE suboperations_l1 AS SELECT 1 AS id, 1 AS action_type_id, 'Уровень 1'::text AS name;
    CREATE TEMP TABLE suboperations_l2 AS SELECT 1 AS id, 1 AS suboperation_l1_id, 'Уровень 2'::text AS name, false AS is_placeholder;
    CREATE TEMP TABLE actions AS SELECT n AS id, 1 AS account_id, 1 AS currency_id, 1 AS suboperation_id,
        timestamp '2026-01-15 12:00:00' AS action_date, 10.01::numeric(19,2) AS amount,
        '<script>тест</script>'::text AS memo, n % 2 = 0 AS is_debit,
        false AS is_black, n % 2 = 0 AS is_checked_user, false AS is_checked_superuser
        FROM generate_series(1, 2001) n;
SQL);
$passed = 0;
$check = function (bool $condition, string $message) use (&$passed): void {
    if (!$condition) throw new RuntimeException($message);
    $passed++;
};
$user = ['can_view_protected' => false, 'data_schema' => 'test', 'login' => '<script>report-user</script>'];
$render = function (array $report) use ($user): string {
    $schemaMismatch = false;
    $confirmation = ['confirmed' => '1', 'schema' => 'test'];
    ob_start();
    require dirname(__DIR__, 2) . '/src/print-template.php';
    return ob_get_clean();
};
$_GET = ['from_date' => '2026-01-01', 'to_date' => '2026-01-31', 'confirmed' => '1'];
$report = printReportData($user);
$check($report['state'] === 'blocked' && $report['count'] === 2001 && !isset($report['items']), 'Cannot bypass hard limit');
$html = $render($report);
$check(str_contains($html, 'Отчёт не сформирован') && !str_contains($html, 'data-operation-id'), 'Blocked page has no partial report');
$pdo->exec('DELETE FROM actions WHERE id = 2001');
$report = printReportData($user);
$check($report['state'] === 'ready' && count($report['items']) === 2000, 'Exactly 2000 prints in full');
$check($report['items'][0]['id'] === 2000 && $report['items'][1999]['id'] === 1, 'Stable sorting by date and ID');
$check($report['summary']['currencies'][0]['income'] === '10010.00', 'Exact income total');
$check($report['summary']['currencies'][0]['expense'] === '10010.00', 'Exact expense total');
$html = $render($report);
$check(substr_count($html, 'data-operation-id') === 2000, 'Template renders full selection');
$check(str_contains($html, 'Сформировал: <span id="report-author">&lt;script&gt;report-user&lt;/script&gt;</span>'), 'Report displays and escapes authenticated login');
$check(!str_contains($html, ' style='), 'Report does not emit inline styles blocked by hosting CSP');
$check(substr_count($html, 'amount-column amount-column--8') === 2, 'Both money columns use the matching external width class');
$check(str_contains($html, '&lt;script&gt;тест&lt;/script&gt;') && !str_contains($html, '<script>тест'), 'Template escapes operation memo');
$check(str_contains($html, '15.01.26 12:00') && !str_contains($html, '15.01.2026 12:00'), 'Compact date keeps time');
$check(str_contains($html, 'Направление → Операция → Уровень 1 → Уровень 2'), 'Classification is rendered as a complete inline chain');
preg_match_all('/<td class="operation-check" data-check-owner="user">(.*?)<\/td>/', $html, $userChecks);
preg_match_all('/<td class="operation-check" data-check-owner="admin">(.*?)<\/td>/', $html, $adminChecks);
$check(count($userChecks[1]) === 2000 && $userChecks[1][0] === 'П✓' && $userChecks[1][1] === '', 'User marks occupy a separate column with empty unchecked cells');
$check(count($adminChecks[1]) === 2000 && array_unique($adminChecks[1]) === [''], 'Unchecked admin marks are empty, without dashes');
$unfilteredGet = $_GET;
$levels = ['direction_id' => ['①', 'Направление'], 'action_type_id' => ['②', 'Операция'],
    'suboperation_l1_id' => ['③', 'Уровень 1'], 'suboperation_l2_id' => ['④', 'Уровень 2']];
foreach ([['direction_id'], ['action_type_id'], ['suboperation_l1_id'], ['suboperation_l2_id'],
    ['direction_id', 'suboperation_l1_id'], array_keys($levels)] as $selected) {
    $_GET = $unfilteredGet + array_fill_keys($selected, '1');
    $filtered = printReportData($user);
    $filteredHtml = $render($filtered);
    $expected = [];
    foreach ($levels as $key => [$symbol, $name]) {
        $expected[] = in_array($key, $selected, true) ? $symbol : $name;
        if (in_array($key, $selected, true)) {
            $check((bool) array_filter($filtered['labels'], fn ($label) => str_starts_with($label, $symbol . ' ') && str_contains($label, $name)), 'Header resolves selected classification symbol');
        }
    }
    preg_match('/<td class="classification">(.*?)<\/td>/s', $filteredHtml, $classification);
    $check(($classification[1] ?? '') === implode(' → ', $expected), 'Only filtered classification names are replaced');
    $check($filtered['count'] === 2000, 'Symbol substitution does not alter the selection');
}
$_GET = $unfilteredGet;
unset($_GET['confirmed']);
$report = printReportData($user);
$check($report['state'] === 'confirm' && !isset($report['items']), 'Warning does not fetch rows');
$html = $render($report);
$check(str_contains($html, 'Продолжить') && !str_contains($html, 'data-operation-id'), 'Warning page requires confirmation without partial rows');
$_GET['income_checked_user'] = '0';
$_GET['expense_checked_superuser'] = '1';
$report = printReportData($user);
$check($report['state'] === 'ready' && $report['count'] === 0, 'Independent flow check filters');
unset($_GET['income_checked_user'], $_GET['expense_checked_superuser']);
$pdo->exec('UPDATE actions SET is_black = true WHERE id > 500');
$_GET['include_protected'] = '1';
$report = printReportData($user);
$check($report['count'] === 500 && count($report['items']) === 500, 'Restricted user cannot include protected records');
$report = printReportData(['can_view_protected' => true]);
$check($report['count'] === 2000 && $report['state'] === 'confirm', 'Administrator can include protected records');
$_GET['memo'] = '<script>';
$_GET['from_date'] = '';
$_GET['to_date'] = '';
$report = printReportData($user);
$check($report['count'] === 500, 'Open dates and literal memo filter');
$_GET['memo'] = 'does-not-exist';
$report = printReportData($user);
$check($report['count'] === 0 && $report['summary']['currencies'] === [], 'Empty result');
$check(!$pdo->inTransaction(), 'Snapshot transaction is closed');
echo "Integration/printing: {$passed} passed\n";
