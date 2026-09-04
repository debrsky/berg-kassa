<?php

declare(strict_types=1);

require dirname(__DIR__) . '/src/app.php';

// X-Robots-Tag is set globally in .htaccess.

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$isLoginPage = $path === '/login';
$isReferencesPage = $path === '/references';
$isAuditPage = $path === '/audit';
$isUsersPage = $path === '/users';

try {
    if ($path === '/api/login') {
        login();
    }
    if ($isLoginPage) {
        if (currentUser()) {
            header('Location: /');
            exit;
        }
    } elseif ($path === '/' || $isReferencesPage || $isAuditPage || $isUsersPage) {
        $pageUser = currentUser();
        if (!$pageUser) {
            header('Location: /login');
            exit;
        }
        if ($isAuditPage) requireProtectedAccess($pageUser, 'audit_access_denied');
        if ($isUsersPage) requireProtectedAccess($pageUser, 'users_access_denied');
    } elseif (str_starts_with($path, '/api/')) {
        $user = requireUser();
        if ($path === '/api/schema') {
            selectDataSchema($user);
        }
        if ($path === '/api/me') {
            me($user);
        }
        if ($path === '/api/logout') {
            logout($user);
        }
        if ($path === '/api/audit-log') {
            auditLog($user);
        }
        if ($path === '/api/users') {
            users($user);
        }
        if (preg_match('#^/api/users/([1-9][0-9]*)$#', $path, $match)) {
            users($user, (int) $match[1]);
        }
        useDataSchema($user['data_schema']);
        if ($path === '/api/actions' && $_SERVER['REQUEST_METHOD'] === 'POST') {
            writeAction($user);
        }
        if (preg_match('#^/api/actions/([1-9][0-9]*)$#', $path, $match)) {
            match ($_SERVER['REQUEST_METHOD']) {
                'PUT' => writeAction($user, (int) $match[1]),
                'DELETE' => deleteAction($user, (int) $match[1]),
                default => jsonResponse(['error' => 'Method not allowed'], 405),
            };
        }
        if (preg_match('#^/api/references/([a-z0-9_]+)$#', $path, $match)) {
            match ($_SERVER['REQUEST_METHOD']) {
                'GET' => references($match[1]),
                'POST' => writeReference($user, $match[1]),
                default => jsonResponse(['error' => 'Method not allowed'], 405),
            };
        }
        if (preg_match('#^/api/references/([a-z0-9_]+)/([1-9][0-9]*)$#', $path, $match)) {
            match ($_SERVER['REQUEST_METHOD']) {
                'PUT' => writeReference($user, $match[1], (int) $match[2]),
                'DELETE' => deleteReference($user, $match[1], (int) $match[2]),
                default => jsonResponse(['error' => 'Method not allowed'], 405),
            };
        }
        match ($path) {
            '/api/lookups' => lookups(),
            '/api/actions' => actions($user),
            '/api/action-summary' => summary($user),
            default => jsonResponse(['error' => 'Not found'], 404),
        };
    } else {
        jsonResponse(['error' => 'Not found'], 404);
    }
} catch (InvalidArgumentException|JsonException $error) {
    jsonResponse(['error' => $error->getMessage()], 400);
} catch (DataSchemaNotFound $error) {
    jsonResponse([
        'error' => $error->getMessage(),
        'code' => 'DATA_SCHEMA_NOT_FOUND',
        'schema' => $error->schema,
    ], 409);
} catch (Throwable $error) {
    error_log((string) $error);
    jsonResponse(['error' => 'Internal server error'], 500);
}

?>
<!doctype html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex">
    <meta name="description" content="Просмотр приходных и расходных операций кассы">
    <script>document.documentElement.dataset.theme = localStorage.getItem('theme') || 'system';</script>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <title><?= $isLoginPage ? 'Вход — Касса' : ($isReferencesPage ? 'Справочники — Касса' : ($isAuditPage ? 'Журнал аудита — Касса' : ($isUsersPage ? 'Пользователи — Касса' : 'Касса — операции'))) ?></title>
    <link rel="stylesheet" href="/css/design-system.css?v=<?= filemtime(__DIR__ . '/css/design-system.css') ?>">
    <link rel="stylesheet" href="/css/app.css?v=<?= filemtime(__DIR__ . '/css/app.css') ?>">
</head>
<body>
<div class="connection-warning" role="status" hidden></div>
<script src="/js/connection.js?v=<?= filemtime(__DIR__ . '/js/connection.js') ?>" defer></script>
<noscript><p role="alert">Для работы приложения включите JavaScript и обновите страницу.</p></noscript>
<?php if ($isLoginPage): ?>
<main class="login-page">
    <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Переключить тему"></button>
    <section class="login-card">
        <p class="login-card__eyebrow">Berg Kassa</p>
        <h1 class="login-card__title">Вход</h1>
        <p class="login-card__subtitle">Введите учётные данные для доступа к операциям.</p>
        <form class="login-card__form" id="login-form" method="post" action="/login">
            <label class="login-card__field">
                <span class="login-card__label">Логин</span>
                <input class="login-card__control" name="login" autocomplete="username" required autofocus>
            </label>
            <label class="login-card__field">
                <span class="login-card__label">Пароль</span>
                <input class="login-card__control" type="password" name="password" autocomplete="off" required>
            </label>
            <p class="login-card__error" id="login-error" role="alert"></p>
            <button class="login-card__submit" type="submit">Войти</button>
        </form>
    </section>
</main>
<script src="/js/login.js?v=<?= filemtime(__DIR__ . '/js/login.js') ?>" defer></script>
<?php elseif ($isAuditPage): ?>
<main class="audit-page">
    <header class="dashboard__header">
        <div>
            <p class="dashboard__eyebrow">Безопасность</p>
            <h1 class="dashboard__title">Журнал аудита</h1>
        </div>
        <div class="dashboard__session">
            <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Переключить тему"></button>
            <span class="dashboard__user" id="current-user"></span>
            <?php require __DIR__ . '/../src/navigation.php'; ?>
            <p class="dashboard__status" id="status" role="status">Загрузка…</p>
        </div>
    </header>
    <form class="audit-filter" id="audit-filter">
        <label><span>Начало периода</span><input type="date" name="from_date" aria-label="Начало периода" title="Пустая дата — без ограничения начала периода"></label>
        <label><span>Конец периода</span><input type="date" name="to_date" aria-label="Конец периода" title="Конечная дата включается в период. Пустая дата — без ограничения конца периода"></label>
        <label><span>Событие</span><select name="event"><option value="">Все события</option></select></label>
        <label><span>Логин</span><input name="login" maxlength="100" autocomplete="off"></label>
        <button type="submit">Применить</button>
        <button type="button" id="audit-reset">Сбросить</button>
    </form>
    <section class="audit-log" aria-live="polite">
        <div class="audit-log__scroll">
            <table>
                <thead><tr><th>Дата</th><th>Событие</th><th>Пользователь</th><th>IP</th><th>Схема</th><th>Объект</th><th>Детали</th></tr></thead>
                <tbody id="audit-rows"></tbody>
            </table>
        </div>
        <footer class="audit-log__pagination">
            <button type="button" id="audit-prev">← Назад</button>
            <span id="audit-page-info"></span>
            <button type="button" id="audit-next">Вперёд →</button>
        </footer>
    </section>
</main>
<script src="/js/audit.js?v=<?= filemtime(__DIR__ . '/js/audit.js') ?>" defer></script>
<?php elseif ($isUsersPage): ?>
<main class="users-page">
    <header class="dashboard__header">
        <div><p class="dashboard__eyebrow">Безопасность</p><h1 class="dashboard__title">Пользователи</h1></div>
        <div class="dashboard__session">
            <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Переключить тему"></button>
            <span class="dashboard__user" id="current-user"></span>
            <?php require __DIR__ . '/../src/navigation.php'; ?>
            <p class="dashboard__status" id="status" role="status">Загрузка…</p>
        </div>
    </header>
    <section class="users-manager">
        <div class="audit-log__scroll">
            <table><thead><tr><th>Логин</th><th>Схемы</th><th>Защищённые операции</th><th>Активен</th><th></th></tr></thead><tbody id="user-rows"></tbody></table>
        </div>
        <form class="reference-manager__form" id="user-form" method="post">
            <input type="hidden" name="id">
            <label class="reference-manager__field"><span>Логин</span><input name="login" maxlength="100" autocomplete="off" required></label>
            <label class="reference-manager__field"><span>Схемы через запятую</span><input name="data_schemas" placeholder="vl, company_2" required></label>
            <label class="reference-manager__field"><span>Пароль <small id="password-hint">(обязателен для нового пользователя)</small></span><input type="password" name="password" minlength="12" autocomplete="new-password"></label>
            <label><input type="checkbox" name="can_view_protected"> Доступ к защищённым операциям</label>
            <label><input type="checkbox" name="is_active" checked> Активен</label>
            <p class="reference-manager__message" id="user-message" role="status"></p>
            <div class="reference-manager__actions"><button type="button" id="new-user">Новый</button><button class="reference-manager__save" type="submit">Сохранить</button></div>
        </form>
    </section>
</main>
<script src="/js/users.js?v=<?= filemtime(__DIR__ . '/js/users.js') ?>" defer></script>
<?php elseif ($isReferencesPage): ?>
<main class="reference-page">
    <header class="dashboard__header">
        <div>
            <p class="dashboard__eyebrow">Настройки</p>
            <h1 class="dashboard__title">Справочники</h1>
        </div>
        <div class="dashboard__session">
            <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Переключить тему"></button>
            <span class="dashboard__user" id="current-user"></span>
            <label class="dashboard__schema-label">
                Схема
                <select class="dashboard__schema" id="data-schema" disabled aria-label="Схема данных"></select>
            </label>
            <?php require __DIR__ . '/../src/navigation.php'; ?>
            <p class="dashboard__status" id="status" role="status">Загрузка…</p>
        </div>
    </header>
    <section class="reference-manager<?= $pageUser['can_view_protected'] ? '' : ' reference-manager--readonly' ?>" inert>
        <div class="reference-manager__toolbar">
            <label class="reference-manager__field">
                <span>Справочник</span>
                <select id="reference-type">
                    <option value="accounts">Счета</option>
                    <option value="currencies">Валюты</option>
                    <option value="currency_rates">Курсы валют</option>
                    <option value="directions">Направления</option>
                    <option value="operation_tree">Операции и подоперации</option>
                </select>
            </label>
            <button class="reference-manager__new" type="button" id="new-reference">+ Добавить</button>
        </div>
        <div class="reference-manager__body">
            <label class="reference-manager__field" id="reference-list-field">
                <span>Записи</span>
                <select class="reference-manager__list" id="reference-list" size="12"></select>
            </label>
            <section class="reference-hierarchy" id="reference-hierarchy" hidden>
                <label class="reference-manager__field reference-hierarchy__direction">
                    <span>Направление</span>
                    <select id="hierarchy-direction"></select>
                </label>
                <div class="reference-hierarchy__columns">
                    <section class="reference-hierarchy__column" data-hierarchy-type="action_types">
                        <header class="reference-hierarchy__header"><strong>Операции</strong><span class="reference-hierarchy__buttons"><button type="button" data-edit-hierarchy aria-label="Редактировать операцию">✎</button><button type="button" data-add-hierarchy>+ Добавить</button></span></header>
                        <input type="search" placeholder="Поиск" aria-label="Поиск операций" data-hierarchy-search>
                        <select size="12" aria-label="Операции" data-hierarchy-list></select>
                    </section>
                    <section class="reference-hierarchy__column" data-hierarchy-type="suboperations_l1">
                        <header class="reference-hierarchy__header"><strong>Подоперации 1</strong><span class="reference-hierarchy__buttons"><button type="button" data-edit-hierarchy aria-label="Редактировать подоперацию 1">✎</button><button type="button" data-add-hierarchy>+ Добавить</button></span></header>
                        <input type="search" placeholder="Поиск" aria-label="Поиск подопераций 1" data-hierarchy-search>
                        <select size="12" aria-label="Подоперации 1" data-hierarchy-list></select>
                    </section>
                    <section class="reference-hierarchy__column" data-hierarchy-type="suboperations_l2">
                        <header class="reference-hierarchy__header"><strong>Подоперации 2</strong><span class="reference-hierarchy__buttons"><button type="button" data-edit-hierarchy aria-label="Редактировать подоперацию 2">✎</button><button type="button" data-add-hierarchy>+ Добавить</button></span></header>
                        <input type="search" placeholder="Поиск" aria-label="Поиск подопераций 2" data-hierarchy-search>
                        <select size="12" aria-label="Подоперации 2" data-hierarchy-list></select>
                    </section>
                </div>
            </section>
            <form class="reference-manager__form" id="reference-form" method="post">
                <input type="hidden" name="id">
                <label class="reference-manager__field" id="reference-parent-field" hidden>
                    <span id="reference-parent-label">Родитель</span>
                    <select name="parent_id"></select>
                </label>
                <label class="reference-manager__field" id="reference-name-field">
                    <span>Название</span>
                    <input name="name" required>
                </label>
                <label class="reference-manager__field" id="reference-date-field" hidden>
                    <span>Дата и время курса</span>
                    <input type="datetime-local" name="rate_date">
                </label>
                <label class="reference-manager__field" id="reference-rate-field" hidden>
                    <span>Курс</span>
                    <input type="number" name="rate" min="0.0001" step="0.0001">
                </label>
                <label class="reference-manager__field" id="reference-memo-field">
                    <span>Примечание</span>
                    <textarea name="memo" rows="3"></textarea>
                </label>
                <p class="reference-manager__message" id="reference-message" role="status"></p>
                <div class="reference-manager__actions">
                    <button class="reference-manager__delete" type="button" id="delete-reference" hidden>Удалить</button>
                    <button class="reference-manager__save" type="submit">Сохранить</button>
                </div>
            </form>
        </div>
    </section>
</main>
<script src="/js/references.js?v=<?= filemtime(__DIR__ . '/js/references.js') ?>" defer></script>
<?php else: ?>
<main class="dashboard">
    <header class="dashboard__header">
        <div>
            <p class="dashboard__eyebrow">Финансовый журнал</p>
            <h1 class="dashboard__title">Касса</h1>
        </div>
        <div class="dashboard__session">
            <button class="theme-toggle" id="theme-toggle" type="button" aria-label="Переключить тему"></button>
            <span class="dashboard__user" id="current-user"></span>
            <label class="dashboard__schema-label">
                Схема
                <select class="dashboard__schema" id="data-schema" disabled aria-label="Схема данных"></select>
            </label>
            <?php require __DIR__ . '/../src/navigation.php'; ?>
            <p class="dashboard__status" id="status" role="status">Загрузка…</p>
        </div>
    </header>

    <form id="filters">
    <fieldset class="filter-bar" id="filter-fields" disabled>
        <label class="filter-bar__field">
            <span class="filter-bar__label">Быстрый выбор</span>
            <select class="filter-bar__control" id="period-preset" aria-label="Период">
                <option value="">Период ▾</option>
                <option value="today">Сегодня</option>
                <option value="yesterday">Вчера</option>
                <option value="week">Эта неделя</option>
                <option value="month">Этот месяц</option>
                <option value="previous-month">Прошлый месяц</option>
                <option value="last30">Последние 30 дней</option>
                <option value="all">За всё время</option>
            </select>
        </label>
        <label class="filter-bar__field">
            <span class="filter-bar__label">С</span>
            <input class="filter-bar__control" type="date" name="from_date" aria-label="Начало периода" title="Пустая дата — без ограничения начала периода">
        </label>
        <label class="filter-bar__field">
            <span class="filter-bar__label">По</span>
            <input class="filter-bar__control" type="date" name="to_date" aria-label="Конец периода" title="Конечная дата включается в период. Пустая дата — без ограничения конца периода">
        </label>
        <label class="filter-bar__field">
            <span class="filter-bar__label">Счёт</span>
            <select class="filter-bar__control" name="account_id"></select>
        </label>
        <label class="filter-bar__field">
            <span class="filter-bar__label">Валюта</span>
            <select class="filter-bar__control" name="currency_id"></select>
        </label>
        <label class="filter-bar__field">
            <span class="filter-bar__label">Направление</span>
            <select class="filter-bar__control" name="direction_id"></select>
        </label>
        <label class="filter-bar__field">
            <span class="filter-bar__label">Операция</span>
            <select class="filter-bar__control" name="action_type_id"></select>
        </label>
        <label class="filter-bar__field">
            <span class="filter-bar__label">Подоперация 1</span>
            <select class="filter-bar__control" name="suboperation_l1_id"></select>
        </label>
        <label class="filter-bar__field">
            <span class="filter-bar__label">Подоперация 2</span>
            <select class="filter-bar__control" name="suboperation_l2_id"></select>
        </label>
        <?php if ($pageUser['can_view_protected']): ?>
        <label class="filter-bar__field filter-bar__field--checkbox" id="protected-filter">
            <span class="filter-bar__checkbox-label">
                <input type="checkbox" name="include_protected" value="1">
                Защищённые
            </span>
        </label>
        <?php else: ?>
        <input type="checkbox" name="include_protected" hidden>
        <?php endif; ?>
        <label class="filter-bar__field">
            <span class="filter-bar__label">Примечание</span>
            <input class="filter-bar__control" type="search" name="memo" maxlength="500" placeholder="Поиск по тексту" autocomplete="off">
        </label>
        <button class="filter-bar__reset" type="button" id="reset-filters">Сбросить</button>
    </fieldset>
    </form>

    <div class="operations-toolbar">
        <div class="operations-tabs" role="tablist" aria-label="Тип операции">
            <button class="operations-tabs__tab operations-tabs__tab--active" id="income-tab" type="button" role="tab"
                    aria-selected="true" aria-controls="income-panel" data-flow-tab="income">Приход</button>
            <button class="operations-tabs__tab" id="expense-tab" type="button" role="tab" aria-selected="false"
                    aria-controls="expense-panel" data-flow-tab="expense" tabindex="-1">Расход</button>
        </div>
    </div>
    <section class="operations-board" aria-label="Операции">
        <section class="operation-panel operation-panel--active" id="income-panel" role="tabpanel"
                 aria-labelledby="income-tab" data-flow="income">
            <header class="operation-panel__header operation-panel__header--income">
                <span class="operation-panel__heading">
                    <span>Приход</span>
                    <button class="operation-panel__add" type="button" data-add-flow="income" disabled>+ Добавить</button>
                </span>
                <span class="operation-panel__count" data-count>0</span>
            </header>
            <div class="operation-panel__columns-scroll" data-columns-scroll>
                <div class="operation-panel__columns" aria-hidden="true">
                    <span>Дата</span><span>Счёт</span><span>Операция</span><span>Подоперация</span><span>Сумма</span>
                </div>
            </div>
            <div class="operation-panel__body" tabindex="0" data-list aria-label="Приходные операции">
                <div class="operation-panel__canvas" data-canvas></div>
            </div>
        </section>
        <section class="operation-panel" id="expense-panel" role="tabpanel"
                 aria-labelledby="expense-tab" data-flow="expense">
            <header class="operation-panel__header operation-panel__header--expense">
                <span class="operation-panel__heading">
                    <span>Расход</span>
                    <button class="operation-panel__add" type="button" data-add-flow="expense" disabled>+ Добавить</button>
                </span>
                <span class="operation-panel__count" data-count>0</span>
            </header>
            <div class="operation-panel__columns-scroll" data-columns-scroll>
                <div class="operation-panel__columns" aria-hidden="true">
                    <span>Дата</span><span>Счёт</span><span>Операция</span><span>Подоперация</span><span>Сумма</span>
                </div>
            </div>
            <div class="operation-panel__body" tabindex="0" data-list aria-label="Расходные операции">
                <div class="operation-panel__canvas" data-canvas></div>
            </div>
        </section>
    </section>

    <section class="summary" aria-label="Итоги и сальдо" aria-live="polite">
        <div class="summary__table-wrap" id="currency-summary"></div>
    </section>

</main>
<dialog class="operation-dialog" id="operation-dialog" aria-labelledby="operation-form-title">
    <form class="operation-form" id="operation-form" method="post">
        <header class="operation-form__header">
            <h2 class="operation-form__title" id="operation-form-title">Новая операция</h2>
            <button class="operation-form__close" type="button" data-close-dialog aria-label="Закрыть">×</button>
        </header>
        <input type="hidden" name="id">
        <div class="operation-form__grid">
            <label class="operation-form__field">
                <span>Тип</span>
                <select name="is_debit" required>
                    <option value="true">Приход</option>
                    <option value="false">Расход</option>
                </select>
            </label>
            <label class="operation-form__field">
                <span>Дата и время</span>
                <input type="datetime-local" name="action_date" required>
            </label>
            <div class="operation-form__currency">
                <label class="operation-form__field">
                    <span>Валюта</span>
                    <select name="currency_id" required></select>
                </label>
                <label class="operation-form__field">
                    <span>Курс</span>
                    <input type="number" name="exchange_rate" min="0.0001" step="0.0001">
                </label>
            </div>
            <label class="operation-form__field">
                <span>Счёт</span>
                <select name="account_id" required></select>
            </label>
            <label class="operation-form__field">
                <span>Направление</span>
                <select name="direction_id" required></select>
            </label>
            <label class="operation-form__field">
                <span>Операция</span>
                <select name="action_type_id" required></select>
            </label>
            <label class="operation-form__field">
                <span>Подоперация 1</span>
                <select name="suboperation_l1_id" required></select>
            </label>
            <label class="operation-form__field">
                <span>Подоперация 2</span>
                <select name="suboperation_id" required></select>
            </label>
            <label class="operation-form__field">
                <span>Сумма</span>
                <input type="number" name="amount" min="0.01" step="0.01" required>
            </label>
            <label class="operation-form__field operation-form__field--wide">
                <span>Примечание</span>
                <textarea name="memo" rows="3"></textarea>
            </label>
            <?php if ($pageUser['can_view_protected']): ?>
            <label class="operation-form__protected" id="operation-protected-field">
                <input type="checkbox" name="is_black"> Защищённая операция
            </label>
            <?php else: ?>
            <input type="checkbox" name="is_black" hidden>
            <?php endif; ?>
            <details class="operation-form__posting" id="operation-posting">
                <summary class="operation-form__posting-title">Выполнить проводку</summary>
                <div class="operation-form__posting-fields">
                    <label class="operation-form__field">
                        <span>Счёт</span>
                        <select name="posting_account_id"></select>
                    </label>
                    <label class="operation-form__field">
                        <span>Подоперация 2</span>
                        <select name="posting_suboperation_id"></select>
                    </label>
                </div>
            </details>
        </div>
        <p class="operation-form__error" id="operation-form-error" role="alert"></p>
        <footer class="operation-form__actions">
            <button class="operation-form__delete" type="button" id="delete-operation" hidden>Удалить</button>
            <button class="operation-form__cancel" type="button" data-close-dialog>Отмена</button>
            <button class="operation-form__save" type="submit">Сохранить</button>
        </footer>
    </form>
</dialog>
<aside class="note-popover" id="note-popover" popover>
    <header class="note-popover__header">
        <strong class="note-popover__title">Примечание</strong>
        <button class="note-popover__close" type="button" popovertarget="note-popover" popovertargetaction="hide" aria-label="Закрыть">×</button>
    </header>
    <p class="note-popover__text" data-note-text></p>
</aside>
<script src="/js/app.js?v=<?= filemtime(__DIR__ . '/js/app.js') ?>" defer></script>
<?php endif; ?>
<?php if (!$isLoginPage): ?>
<script src="/js/navigation.js?v=<?= filemtime(__DIR__ . '/js/navigation.js') ?>" defer></script>
<?php endif; ?>
<script src="/js/theme.js?v=<?= filemtime(__DIR__ . '/js/theme.js') ?>" defer></script>
</body>
</html>
