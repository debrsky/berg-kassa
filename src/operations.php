<?php

declare(strict_types=1);

function positiveDecimal(mixed $value, int $precision, int $scale, string $field): string
{
    if ((!is_string($value) && !is_int($value) && !is_float($value))
        || !preg_match('/^([0-9]+)(?:\.([0-9]+))?$/D', (string) $value, $parts)) {
        throw new InvalidArgumentException("Invalid field: {$field}");
    }
    $whole = ltrim($parts[1], '0') ?: '0';
    if (strlen($whole) > $precision - $scale) {
        throw new InvalidArgumentException("Invalid field: {$field}");
    }
    $fraction = str_pad($parts[2] ?? '', $scale + 1, '0');
    $units = (int) substr($fraction, 0, $scale);
    if ((int) $fraction[$scale] >= 5) $units++;
    if ($units === 10 ** $scale) {
        $whole = (string) ((int) $whole + 1);
        $units = 0;
    }
    if (strlen($whole) > $precision - $scale || ($whole === '0' && $units === 0)) {
        throw new InvalidArgumentException("Invalid field: {$field}");
    }
    return $whole . '.' . str_pad((string) $units, $scale, '0', STR_PAD_LEFT);
}

function actionBody(): array
{
    $body = json_decode(file_get_contents('php://input'), true, flags: JSON_THROW_ON_ERROR);
    if (!is_array($body)) {
        throw new InvalidArgumentException('Invalid request body');
    }
    foreach (['account_id', 'currency_id', 'suboperation_id'] as $name) {
        if (!isset($body[$name]) || !ctype_digit((string) $body[$name]) || (int) $body[$name] < 1) {
            throw new InvalidArgumentException("Invalid field: {$name}");
        }
        $body[$name] = (int) $body[$name];
    }
    $date = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i', (string) ($body['action_date'] ?? ''));
    if (!$date || $date->format('Y-m-d\TH:i') !== ($body['action_date'] ?? '')) {
        throw new InvalidArgumentException('Invalid field: action_date');
    }
    $amount = positiveDecimal($body['amount'] ?? null, 19, 2, 'amount');
    $exchangeRate = $body['exchange_rate'] ?? null;
    $exchangeRate = $exchangeRate === null || $exchangeRate === ''
        ? null : positiveDecimal($exchangeRate, 12, 4, 'exchange_rate');
    $isDebit = filter_var($body['is_debit'] ?? null, FILTER_VALIDATE_BOOL, FILTER_NULL_ON_FAILURE);
    $isBlack = filter_var($body['is_black'] ?? false, FILTER_VALIDATE_BOOL, FILTER_NULL_ON_FAILURE);
    if ($isDebit === null || $isBlack === null) {
        throw new InvalidArgumentException('Invalid boolean field');
    }
    $posting = $body['posting'] ?? null;
    if ($posting !== null) {
        if (!is_array($posting)) {
            throw new InvalidArgumentException('Invalid field: posting');
        }
        foreach (['account_id', 'suboperation_id'] as $name) {
            if (!isset($posting[$name]) || !ctype_digit((string) $posting[$name]) || (int) $posting[$name] < 1) {
                throw new InvalidArgumentException("Invalid posting field: {$name}");
            }
            $posting[$name] = (int) $posting[$name];
        }
    }
    return [
        'account_id' => $body['account_id'],
        'currency_id' => $body['currency_id'],
        'suboperation_id' => $body['suboperation_id'],
        'action_date' => $date->format('Y-m-d H:i:s'),
        'amount' => $amount,
        'exchange_rate' => $exchangeRate,
        'is_debit' => $isDebit,
        'memo' => trim((string) ($body['memo'] ?? '')) ?: null,
        'is_black' => $isBlack,
        '_posting' => $posting,
    ];
}

function writeAction(array $user, ?int $id = null): never
{
    requireCsrf($user);
    $values = actionBody();
    $posting = $values['_posting'];
    unset($values['_posting']);
    if ($id !== null && $posting !== null) {
        throw new InvalidArgumentException('Posting is only available for new operations');
    }
    if ($values['is_black'] && !$user['can_view_protected']) {
        auditEvent('access.denied', $user, 'actions', $id, ['reason' => 'protected_operation']);
        jsonResponse(['error' => 'Protected operation access denied'], 403);
    }
    $pdo = db();
    foreach (['accounts' => 'account_id', 'currencies' => 'currency_id', 'suboperations_l2' => 'suboperation_id'] as $table => $field) {
        $statement = $pdo->prepare("SELECT 1 FROM {$table} WHERE id = :id");
        $statement->execute(['id' => $values[$field]]);
        if (!$statement->fetchColumn()) {
            throw new InvalidArgumentException("Unknown field value: {$field}");
        }
    }
    if ($posting !== null) {
        foreach (['accounts' => 'account_id', 'suboperations_l2' => 'suboperation_id'] as $table => $field) {
            $statement = $pdo->prepare("SELECT 1 FROM {$table} WHERE id = :id");
            $statement->execute(['id' => $posting[$field]]);
            if (!$statement->fetchColumn()) {
                throw new InvalidArgumentException("Unknown posting field value: {$field}");
            }
        }
    }
    $values['is_debit'] = $values['is_debit'] ? 'true' : 'false';
    $values['is_black'] = $values['is_black'] ? 'true' : 'false';
    $pdo->beginTransaction();
    if ($id === null) {
        $sql = 'INSERT INTO actions (account_id, currency_id, suboperation_id, action_date, amount, '
            . 'exchange_rate, is_debit, memo, is_black) VALUES (:account_id, :currency_id, :suboperation_id, '
            . ':action_date, :amount, :exchange_rate, :is_debit, :memo, :is_black) RETURNING id';
    } else {
        $access = $pdo->prepare('SELECT * FROM actions WHERE id = :id FOR UPDATE');
        $access->execute(['id' => $id]);
        $action = $access->fetch();
        if (!$action) {
            $pdo->rollBack();
            jsonResponse(['error' => 'Operation not found'], 404);
        }
        if ((bool) $action['is_black'] && !$user['can_view_protected']) {
            $pdo->rollBack();
            auditEvent('access.denied', $user, 'actions', $id, ['reason' => 'protected_operation']);
            jsonResponse(['error' => 'Protected operation access denied'], 403);
        }
        $sql = 'UPDATE actions SET account_id = :account_id, currency_id = :currency_id, '
            . 'suboperation_id = :suboperation_id, action_date = :action_date, amount = :amount, '
            . 'exchange_rate = :exchange_rate, is_debit = :is_debit, memo = :memo, is_black = :is_black '
            . 'WHERE id = :id RETURNING id';
        $values['id'] = $id;
    }
    $old = $id === null ? null : $action;
    try {
        $statement = $pdo->prepare($sql);
        $statement->execute($values);
        $result = ['id' => (int) $statement->fetchColumn()];
        $saved = $pdo->prepare('SELECT * FROM actions WHERE id = :id');
        $saved->execute(['id' => $result['id']]);
        auditEvent('action.' . ($id === null ? 'created' : 'updated'), $user, 'actions', $result['id'], ['old' => $old, 'new' => $saved->fetch()], pdo: $pdo);
        if ($posting !== null) {
            $values['account_id'] = $posting['account_id'];
            $values['suboperation_id'] = $posting['suboperation_id'];
            $values['is_debit'] = $values['is_debit'] === 'true' ? 'false' : 'true';
            $statement->execute($values);
            $result['posting_id'] = (int) $statement->fetchColumn();
            $saved->execute(['id' => $result['posting_id']]);
            auditEvent('action.created', $user, 'actions', $result['posting_id'], ['old' => null, 'new' => $saved->fetch()], pdo: $pdo);
        }
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
    jsonResponse($result, $id === null ? 201 : 200);
}

function deleteAction(array $user, int $id): never
{
    requireCsrf($user);
    $pdo = db();
    $pdo->beginTransaction();
    $statement = $pdo->prepare('SELECT * FROM actions WHERE id = :id'
        . ($user['can_view_protected'] ? '' : ' AND is_black = false') . ' FOR UPDATE');
    $statement->execute(['id' => $id]);
    $old = $statement->fetch();
    if (!$old) {
        $pdo->rollBack();
        auditEvent('access.denied', $user, 'actions', $id, ['reason' => 'not_found_or_protected']);
        jsonResponse(['error' => 'Operation not found or access denied'], 404);
    }
    try {
        $statement = $pdo->prepare('DELETE FROM actions WHERE id = :id');
        $statement->execute(['id' => $id]);
        auditEvent('action.deleted', $user, 'actions', $id, ['old' => $old], pdo: $pdo);
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
    jsonResponse(['ok' => true]);
}

function checkAction(array $user, int $id): never
{
    requireCsrf($user);
    $body = json_decode(file_get_contents('php://input'), true, flags: JSON_THROW_ON_ERROR);
    if (!is_array($body) || !array_key_exists('checked', $body) || !is_bool($body['checked'])) {
        throw new InvalidArgumentException('Invalid field: checked');
    }
    $column = $user['can_view_protected'] ? 'is_checked_superuser' : 'is_checked_user';
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $statement = $pdo->prepare('SELECT * FROM actions WHERE id = :id'
            . ($user['can_view_protected'] ? '' : ' AND is_black = false') . ' FOR UPDATE');
        $statement->execute(['id' => $id]);
        $old = $statement->fetch();
        if (!$old) {
            $pdo->rollBack();
            jsonResponse(['error' => 'Operation not found or access denied'], 404);
        }
        $statement = $pdo->prepare("UPDATE actions SET {$column} = :checked WHERE id = :id RETURNING *");
        $statement->execute(['checked' => $body['checked'] ? 'true' : 'false', 'id' => $id]);
        $saved = $statement->fetch();
        auditEvent('action.checked', $user, 'actions', $id, ['old' => $old, 'new' => $saved], pdo: $pdo);
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
    jsonResponse([
        'is_checked_user' => (bool) $saved['is_checked_user'],
        'is_checked_superuser' => (bool) $saved['is_checked_superuser'],
    ]);
}

function actions(array $user): never
{
    $flow = $_GET['flow'] ?? '';
    if (!in_array($flow, ['income', 'expense'], true)) {
        throw new InvalidArgumentException('flow must be income or expense');
    }
    $filters = filters(true, $user['can_view_protected'], $flow . '_');
    $offset = (string) ($_GET['offset'] ?? '0');
    $limit = (string) ($_GET['limit'] ?? '100');
    if (!ctype_digit($offset) || !ctype_digit($limit) || (int) $limit < 1 || (int) $limit > 200) {
        throw new InvalidArgumentException('Invalid offset or limit');
    }
    $offset = (int) $offset;
    $limit = (int) $limit;

    $params = [];
    $where = filterSql($filters, $params, true);
    $base = ' FROM actions a ' . joins()
        . ' WHERE a.is_debit = ' . ($flow === 'income' ? 'TRUE' : 'FALSE') . $where;
    $total = null;
    if (($_GET['include_total'] ?? '0') === '1') {
        $statement = db()->prepare('SELECT COUNT(*)' . $base);
        $statement->execute($params);
        $total = (int) $statement->fetchColumn();
    }

    $page = 'SELECT a.id' . $base
        . ' ORDER BY a.action_date DESC, a.id DESC '
        . "LIMIT {$limit} OFFSET {$offset}";
    $sql = 'WITH page AS (' . $page . ') SELECT a.id, a.account_id, a.currency_id, a.suboperation_id, '
        . 'a.action_date, a.amount, a.exchange_rate, a.is_debit, a.memo, a.is_black, '
        . 'a.is_checked_user, a.is_checked_superuser, '
        . 'ac.name AS account, c.name AS currency, '
        . 'd.name AS direction, at.name AS action_type, s1.name AS suboperation_l1, '
        . 's2.name AS suboperation_l2, s2.is_placeholder AS suboperation_placeholder '
        . 'FROM page p JOIN actions a ON a.id = p.id ' . joins()
        . ' ORDER BY a.action_date DESC, a.id DESC';
    $statement = db()->prepare($sql);
    $statement->execute($params);
    $items = $statement->fetchAll();
    jsonResponse(['items' => $items, 'total' => $total]);
}

function summary(array $user): never
{
    jsonResponse(actionSummaryData($user));
}

function actionSummaryData(array $user, ?array $selectedFilters = null): array
{
    $filters = $selectedFilters ?? filters(true, $user['can_view_protected']);
    $params = ['from_date' => $filters['from_date'], 'to_date' => $filters['to_date']];
    $where = filterSql($filters, $params, false);
    $where .= flowCheckSql($params);
    $base = ' FROM actions a ' . joins() . ' WHERE a.action_date < (:to_date::date + INTERVAL \'1 day\')' . $where;
    $measures = <<<'SQL'
        COALESCE(SUM(CASE WHEN a.action_date < :from_date THEN
            CASE WHEN a.is_debit THEN a.amount ELSE -a.amount END ELSE 0 END), 0) AS opening,
        COALESCE(SUM(CASE WHEN a.action_date >= :from_date AND a.is_debit THEN a.amount ELSE 0 END), 0) AS income,
        COALESCE(SUM(CASE WHEN a.action_date >= :from_date AND NOT a.is_debit THEN a.amount ELSE 0 END), 0) AS expense,
        COUNT(*) FILTER (WHERE a.action_date >= :from_date) AS operation_count
    SQL;

    $statement = db()->prepare('SELECT totals.*, income - expense AS current, '
        . 'opening + income - expense AS closing FROM (SELECT c.id AS currency_id, c.name AS currency, '
        . $measures . $base . ' GROUP BY c.id, c.name) totals ORDER BY currency NULLS LAST, currency_id');
    $statement->execute($params);
    $currencies = $statement->fetchAll();

    return [
        'currencies' => $currencies,
        'operation_count' => array_sum(array_column($currencies, 'operation_count')),
    ];
}

function flowCheckSql(array &$params): string
{
    $flowChecks = [];
    foreach (['income' => 'a.is_debit', 'expense' => 'NOT a.is_debit'] as $flow => $direction) {
        $checks = [$direction];
        foreach (['checked_user' => 'is_checked_user', 'checked_superuser' => 'is_checked_superuser'] as $name => $column) {
            $value = booleanParameter("{$flow}_{$name}");
            if ($value !== null) {
                $parameter = "{$flow}_{$name}";
                $checks[] = "a.{$column} = :{$parameter}";
                $params[$parameter] = $value ? 'true' : 'false';
            }
        }
        $flowChecks[$flow] = $checks;
    }
    if (count($flowChecks['income']) > 1 || count($flowChecks['expense']) > 1) {
        return ' AND ((' . implode(' AND ', $flowChecks['income']) . ') OR ('
            . implode(' AND ', $flowChecks['expense']) . '))';
    }
    return '';
}
