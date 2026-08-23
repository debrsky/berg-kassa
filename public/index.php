<?php

declare(strict_types=1);

require dirname(__DIR__) . '/src/app.php';

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$isLoginPage = $path === '/login';

try {
    if ($path === '/api/login') {
        login();
    }
    if ($isLoginPage) {
        if (currentUser()) {
            header('Location: /');
            exit;
        }
    } elseif ($path === '/') {
        if (!currentUser()) {
            header('Location: /login');
            exit;
        }
    } elseif (str_starts_with($path, '/api/')) {
        $user = requireUser();
        if ($path === '/api/schema') {
            selectDataSchema($user);
        }
        if ($path === '/api/me') {
            me($user);
        }
        if ($path === '/api/logout') {
            logout();
        }
        useDataSchema($user['data_schema']);
        match ($path) {
            '/api/lookups' => lookups(),
            '/api/actions' => actions($user),
            '/api/action-summary' => summary($user),
            default => jsonResponse(['error' => 'Not found'], 404),
        };
    } else {
        jsonResponse(['error' => 'Not found'], 404);
    }
} catch (InvalidArgumentException $error) {
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
    <meta name="description" content="Просмотр приходных и расходных операций кассы">
    <title><?= $isLoginPage ? 'Вход — Касса' : 'Касса — операции' ?></title>
    <link rel="stylesheet" href="/css/design-system.css">
    <link rel="stylesheet" href="/css/app.css">
</head>
<body>
<?php if ($isLoginPage): ?>
<main class="login-page">
    <section class="login-card">
        <p class="login-card__eyebrow">Berg Kassa</p>
        <h1 class="login-card__title">Вход</h1>
        <p class="login-card__subtitle">Введите учётные данные для доступа к операциям.</p>
        <form class="login-card__form" id="login-form">
            <label class="login-card__field">
                <span class="login-card__label">Логин</span>
                <input class="login-card__control" name="login" autocomplete="username" required autofocus>
            </label>
            <label class="login-card__field">
                <span class="login-card__label">Пароль</span>
                <input class="login-card__control" type="password" name="password" autocomplete="current-password" required>
            </label>
            <p class="login-card__error" id="login-error" role="alert"></p>
            <button class="login-card__submit" type="submit">Войти</button>
        </form>
    </section>
</main>
<script src="/js/login.js" defer></script>
<?php else: ?>
<main class="dashboard">
    <header class="dashboard__header">
        <div>
            <p class="dashboard__eyebrow">Финансовый журнал</p>
            <h1 class="dashboard__title">Касса</h1>
        </div>
        <div class="dashboard__session">
            <span class="dashboard__user" id="current-user"></span>
            <label class="dashboard__schema-label">
                Схема
                <select class="dashboard__schema" id="data-schema" aria-label="Схема данных"></select>
            </label>
            <button class="dashboard__logout" type="button" id="logout">Выйти</button>
            <p class="dashboard__status" id="status">Загрузка…</p>
        </div>
    </header>

    <form class="filter-bar" id="filters">
        <label class="filter-bar__field">
            <span class="filter-bar__label">Начало периода</span>
            <input class="filter-bar__control" type="date" name="from_date">
        </label>
        <label class="filter-bar__field">
            <span class="filter-bar__label">Конец периода</span>
            <input class="filter-bar__control" type="date" name="to_date">
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
        <label class="filter-bar__field filter-bar__field--checkbox" id="protected-filter">
            <span class="filter-bar__checkbox-label">
                <input type="checkbox" name="include_protected" value="1">
                Защищённые
            </span>
        </label>
        <button class="filter-bar__reset" type="button" id="reset">Сбросить</button>
    </form>

    <div class="operations-tabs" role="tablist" aria-label="Тип операции">
        <button class="operations-tabs__tab operations-tabs__tab--active" id="income-tab" type="button" role="tab"
                aria-selected="true" aria-controls="income-panel" data-flow-tab="income">Приход</button>
        <button class="operations-tabs__tab" id="expense-tab" type="button" role="tab" aria-selected="false"
                aria-controls="expense-panel" data-flow-tab="expense" tabindex="-1">Расход</button>
    </div>
    <section class="operations-board" aria-label="Операции">
        <section class="operation-panel operation-panel--active" id="income-panel" role="tabpanel"
                 aria-labelledby="income-tab" data-flow="income">
            <header class="operation-panel__header operation-panel__header--income">
                <span>Приход</span><span class="operation-panel__count" data-count>0</span>
            </header>
            <div class="operation-panel__columns" aria-hidden="true">
                <span>Дата</span><span>Счёт</span><span>Операция</span><span>Подоперация</span><span>Сумма</span>
            </div>
            <div class="operation-panel__body" tabindex="0" data-list aria-label="Приходные операции">
                <div class="operation-panel__canvas" data-canvas></div>
            </div>
        </section>
        <section class="operation-panel" id="expense-panel" role="tabpanel"
                 aria-labelledby="expense-tab" data-flow="expense">
            <header class="operation-panel__header operation-panel__header--expense">
                <span>Расход</span><span class="operation-panel__count" data-count>0</span>
            </header>
            <div class="operation-panel__columns" aria-hidden="true">
                <span>Дата</span><span>Счёт</span><span>Операция</span><span>Подоперация</span><span>Сумма</span>
            </div>
            <div class="operation-panel__body" tabindex="0" data-list aria-label="Расходные операции">
                <div class="operation-panel__canvas" data-canvas></div>
            </div>
        </section>
    </section>

    <section class="summary" aria-live="polite">
        <div class="summary__header">
            <div>
                <p class="summary__eyebrow">По выбранному периоду</p>
                <h2 class="summary__title">Итоги и сальдо</h2>
            </div>
            <span class="summary__count" id="summary-count"></span>
        </div>
        <div class="summary__table-wrap" id="currency-summary"></div>
        <details class="summary__details">
            <summary class="summary__details-title">По направлениям</summary>
            <div class="summary__table-wrap" id="direction-summary"></div>
        </details>
    </section>
</main>
<aside class="note-popover" id="note-popover" popover>
    <header class="note-popover__header">
        <strong class="note-popover__title">Примечание</strong>
        <button class="note-popover__close" type="button" popovertarget="note-popover" popovertargetaction="hide" aria-label="Закрыть">×</button>
    </header>
    <p class="note-popover__text" data-note-text></p>
</aside>
<script src="/js/app.js" defer></script>
<?php endif; ?>
</body>
</html>
