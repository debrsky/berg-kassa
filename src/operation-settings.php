<?php

declare(strict_types=1);

function operationEditDays(): int
{
    return (int) db()->query('SELECT edit_days FROM auth.operation_settings WHERE id = 1')->fetchColumn();
}

function operationEditFrom(int $days, ?DateTimeImmutable $now = null): string
{
    if ($days < 1) throw new InvalidArgumentException('Период должен быть целым числом от 1');
    // HTML dates and PostgreSQL AD dates share this lower bound. A very large
    // N should allow all supported dates, not produce a negative-year UI value.
    return max('0001-01-01', ($now ?? new DateTimeImmutable())->setTime(0, 0)->modify('-' . ($days - 1) . ' days')->format('Y-m-d'));
}

function operationDateAllowed(string $date, string $from): bool
{
    return substr($date, 0, 10) >= $from;
}

// Called inside the mutation transaction, after locking the existing action.
function requireOperationDateAccess(array $user, array $dates, ?int $id = null): void
{
    if ($user['can_view_protected']) return;
    $pdo = db();
    $days = (int) $pdo->query('SELECT edit_days FROM auth.operation_settings WHERE id = 1 FOR SHARE')->fetchColumn();
    $from = operationEditFrom($days);
    foreach ($dates as $date) {
        if (operationDateAllowed($date, $from)) continue;
        $pdo->rollBack();
        auditEvent('access.denied', $user, 'actions', $id, ['reason' => 'operation_date_locked', 'edit_from' => $from]);
        jsonResponse([
            'error' => 'Изменения операций доступны с ' . (new DateTimeImmutable($from))->format('d.m.Y') . '. Более ранние операции доступны только для просмотра.',
            'code' => 'OPERATION_DATE_LOCKED',
            'operation_edit_from' => $from,
        ], 403);
    }
}

function operationSettings(array $user): never
{
    requireProtectedAccess($user, 'settings_access_denied');
    if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        jsonResponse(['edit_days' => operationEditDays(), 'server_timezone' => date_default_timezone_get()]);
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'PUT') jsonResponse(['error' => 'Method not allowed'], 405);
    requireCsrf($user);
    $body = json_decode(file_get_contents('php://input'), true, flags: JSON_THROW_ON_ERROR);
    $days = $body['edit_days'] ?? null;
    if (!is_int($days) || $days < 1 || $days > 2147483647) {
        throw new InvalidArgumentException('Период должен быть целым числом от 1 до 2147483647');
    }
    $pdo = db();
    $pdo->beginTransaction();
    try {
        $old = (int) $pdo->query('SELECT edit_days FROM auth.operation_settings WHERE id = 1 FOR UPDATE')->fetchColumn();
        $statement = $pdo->prepare('UPDATE auth.operation_settings SET edit_days = :days WHERE id = 1');
        $statement->execute(['days' => $days]);
        auditEvent('settings.updated', $user, 'operation_settings', 1, [
            'old' => ['edit_days' => $old], 'new' => ['edit_days' => $days],
        ], pdo: $pdo);
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $error;
    }
    jsonResponse(['edit_days' => $days]);
}
