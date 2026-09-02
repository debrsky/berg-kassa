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
    'include_protected' => false, 'from_date' => '2026-01-01', 'to_date' => '2026-01-31',
], $params, true);
check(str_contains($sql, 'a.account_id = :account_id'), 'filterSql applies IDs');
check(str_contains($sql, 'a.is_black = false'), 'filterSql hides protected rows');
check($params['account_id'] === 7 && count($params) === 3, 'filterSql binds expected values');

$balances = addBalances([['opening' => '10', 'income' => '5.25', 'expense' => '2.10']]);
check($balances[0]['current'] === '3.15', 'current balance is correct');
check($balances[0]['closing'] === '13.15', 'closing balance is correct');
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

echo "Unit: {$passed} passed\n";
