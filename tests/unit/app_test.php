<?php

declare(strict_types=1);

require dirname(__DIR__, 2) . '/src/app.php';

$passed = 0;
function check(bool $condition, string $message): void
{
    global $passed;
    if (!$condition) {
        throw new RuntimeException($message);
    }
    $passed++;
}

$_GET = ['id' => '42'];
check(integerParameter('id') === 42, 'integerParameter accepts positive integers');
$_GET = ['id' => '0'];
try {
    integerParameter('id');
    check(false, 'integerParameter rejects zero');
} catch (InvalidArgumentException) {
    check(true, 'integerParameter rejects zero');
}

$_GET = ['checked' => '0'];
check(booleanParameter('checked') === false, 'booleanParameter accepts false');
$_GET = ['checked' => 'yes'];
try {
    booleanParameter('checked');
    check(false, 'booleanParameter rejects unknown values');
} catch (InvalidArgumentException) {
    check(true, 'booleanParameter rejects unknown values');
}

$_GET = ['date' => '2026-02-29'];
try {
    dateParameter('date', '2026-01-01');
    check(false, 'dateParameter rejects invalid dates');
} catch (InvalidArgumentException) {
    check(true, 'dateParameter rejects invalid dates');
}

$_GET = ['from_date' => '2026-02-02', 'to_date' => '2026-02-01'];
try {
    filters();
    check(false, 'filters rejects reversed periods');
} catch (InvalidArgumentException) {
    check(true, 'filters rejects reversed periods');
}

$params = [];
$sql = filterSql([
    'account_id' => 7, 'currency_id' => null, 'direction_id' => null,
    'action_type_id' => null, 'suboperation_l1_id' => null, 'suboperation_l2_id' => null,
    'checked_user' => true, 'checked_superuser' => false,
    'include_protected' => false, 'from_date' => '2026-01-01', 'to_date' => '2026-01-31',
], $params, true);
check(str_contains($sql, 'a.account_id = :account_id'), 'filterSql applies IDs');
check(str_contains($sql, 'a.is_black = false'), 'filterSql hides protected rows');
check(str_contains($sql, 'a.is_checked_user = :checked_user'), 'filterSql applies user check');
check(str_contains($sql, 'a.is_checked_superuser = :checked_superuser'), 'filterSql applies superuser check');
check($params['account_id'] === 7 && count($params) === 5, 'filterSql binds expected values');

check(positiveDecimal('99999999999999999.99', 19, 2, 'amount') === '99999999999999999.99', 'large amount remains exact');
check(positiveDecimal('0001.995', 19, 2, 'amount') === '2.00', 'decimal rounding carries exactly');
check(positiveDecimal('1.23455', 12, 4, 'rate') === '1.2346', 'rate rounds to four digits');
foreach (['0', '0.001', '-1', '99999999999999999.995', [], true, '1e99'] as $invalid) {
    try {
        positiveDecimal($invalid, 19, 2, 'amount');
        check(false, 'invalid amount rejected');
    } catch (InvalidArgumentException) {
        check(true, 'invalid amount rejected');
    }
}
check(referenceConfig('accounts')['table'] === 'accounts', 'reference config is available');
try {
    referenceConfig('invalid');
    check(false, 'unknown reference is rejected');
} catch (InvalidArgumentException) {
    check(true, 'unknown reference is rejected');
}
check(strlen(csrfToken()) === 64, 'CSRF token has expected entropy');

$ip = 'unit-test-' . bin2hex(random_bytes(8));
[$handle, $attempts] = loginAttempts($ip, 1000);
check($attempts === [], 'login rate limit starts empty');
saveLoginAttempts($handle, [900, 950, 1000]);
[$handle, $attempts] = loginAttempts($ip, 1001);
check($attempts === [950, 1000], 'login rate limit expires old attempts');
saveLoginAttempts($handle, []);
unlink(loginAttemptFile($ip));

require dirname(__DIR__, 2) . '/src/printing.php';
foreach ([0, 500, 501, 2000, 2001] as $count) {
    check(printVolumeState($count, false) === ($count > 2000 ? 'blocked' : ($count > 500 ? 'confirm' : 'ready')), 'Print volume boundaries');
    check(printVolumeState($count, true) === ($count > 2000 ? 'blocked' : 'ready'), 'Confirmation cannot bypass limit');
}
check(printMoney('99999999999999999.99') === '99 999 999 999 999 999,99', 'Print amount preserves precision');
check(printMoney('-1234.00') === '-1 234,00', 'Negative balance formatting');
check(printMoney(null) === '—', 'Missing amount formatting');
check(printAmountCharacters([]) === 8, 'Empty report keeps readable amount columns');
check(printAmountCharacters([['amount' => null], ['amount' => '99999999999999999.99']]) === 25, 'Amount columns accommodate the full largest amount');
check(printEscape('<script>"&') === '&lt;script&gt;&quot;&amp;', 'Print text is escaped');
check(printClassificationMarkers([]) === [], 'No classification references without filters');
check(printClassificationMarkers(['direction_id' => 7, 'action_type_id' => null, 'suboperation_l1_id' => 3]) === ['direction' => '①', 'suboperation_l1' => '③'], 'Only explicitly selected levels receive stable symbols');
check(printClassificationMarkers(['suboperation_l2_id' => 9]) === ['suboperation_l2' => '④'], 'Selecting a child alone does not hide its ancestors');
$_GET = ['income_checked_user' => '0', 'expense_checked_superuser' => '1'];
$params = [];
$sql = flowCheckSql($params);
check(str_contains($sql, ' OR ') && $params === ['income_checked_user' => 'false', 'expense_checked_superuser' => 'true'], 'Combined report preserves per-flow checks');

echo "Unit: {$passed} passed\n";
