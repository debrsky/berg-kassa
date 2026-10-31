<!doctype html>
<html lang="ru">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <title>Операции — печать — Касса</title>
    <link rel="stylesheet" href="/css/print.css?v=<?= filemtime(__DIR__ . '/../public/css/print.css') ?>">
    <script src="/js/print.js?v=<?= filemtime(__DIR__ . '/../public/js/print.js') ?>" defer></script>
</head>
<body>
<main>
    <h1>Ведомость операций<?php if (!$schemaMismatch): ?> <small>· Схема: <?= printEscape($user['data_schema']) ?></small><?php endif; ?></h1>
    <?php if ($schemaMismatch): ?>
    <p role="alert">Рабочая схема изменилась. Вернитесь к операциям и заново нажмите «Печать».</p>
    <?php else: ?>
    <p class="report-period">Период: <?= $report['filters']['from_date'] === '-infinity' ? 'без начальной даты' : printEscape($report['filters']['from_date']) ?> —
        <?= $report['filters']['to_date'] === 'infinity' ? 'без конечной даты' : printEscape($report['filters']['to_date']) ?>.
        Операций: <strong id="operation-count"><?= $report['count'] ?></strong>.</p>
    <p class="report-filters"><?= printEscape(implode('; ', $report['labels'])) ?>.
        Сформировано: <?= printEscape(date('d.m.Y H:i:s T')) ?>.
        Сформировал: <span id="report-author"><?= printEscape($user['login']) ?></span>.</p>
    <?php if ($report['state'] === 'blocked'): ?>
    <p role="alert">Найдено <?= $report['count'] ?> операций. Максимум для одного отчёта — <?= PRINT_MAX_COUNT ?>.
        Уменьшите период или уточните фильтры. Отчёт не сформирован.</p>
    <?php elseif ($report['state'] === 'confirm'): ?>
    <p>В отчёте <?= $report['count'] ?> операций. Документ может содержать много страниц. Продолжить?</p>
    <form method="get" action="/print/actions">
        <?php foreach ($confirmation as $name => $value): ?>
        <input type="hidden" name="<?= printEscape($name) ?>" value="<?= printEscape($value) ?>">
        <?php endforeach; ?>
        <button type="submit">Продолжить</button>
    </form>
    <?php else: ?>
    <div class="print-controls">
        <button type="button" id="print-report">Печать / сохранить PDF</button>
        <p>A4, портретная ориентация по умолчанию. Настройки можно изменить в диалоге печати браузера.</p>
    </div>
    <div class="table-scroll">
    <?php
    $amountCharacters = printAmountCharacters($report['items']);
    $classificationMarkers = printClassificationMarkers($report['filters']);
    ?>
    <table class="operations">
        <caption>Приход и расход, дата и ID по убыванию. <span class="report-legend">П✓ — отметка пользователя, А✓ — администратора; пусто — не поставлена; З — защищённая.<?php if ($classificationMarkers): ?> ①–④ в назначении — ссылки на выбранные фильтры в шапке.<?php endif; ?></span></caption>
        <colgroup><col class="date-column"><col class="account-column"><col><col><col class="check-column" span="2">
            <col class="amount-column amount-column--<?= $amountCharacters ?>">
            <col class="amount-column amount-column--<?= $amountCharacters ?>">
        </colgroup>
        <thead><tr><th scope="col">Дата / №</th><th scope="col">Счёт / валюта</th><th scope="col">Назначение</th><th scope="col">Примечание</th><th class="operation-check" scope="col" aria-label="Отметка пользователя" title="Отметка пользователя">П</th><th class="operation-check" scope="col" aria-label="Отметка администратора" title="Отметка администратора">А</th><th class="money" scope="col">Приход</th><th class="money" scope="col">Расход</th></tr></thead>
        <tbody>
        <?php foreach ($report['items'] as $item): ?>
        <tr data-operation-id="<?= (int) $item['id'] ?>">
            <td><span class="operation-date"><?= printEscape((new DateTimeImmutable($item['action_date']))->format('d.m.y H:i')) ?></span>
                <div class="operation-meta">№ <?= (int) $item['id'] ?><?php if ($item['is_black']): ?> · <strong>З</strong><?php endif; ?></div>
            </td>
            <td><?= printEscape($item['account'] ?? '—') ?><br><?= printEscape($item['currency'] ?? '—') ?></td>
            <td class="classification"><?php foreach (['direction', 'action_type', 'suboperation_l1', 'suboperation_l2'] as $index => $key): ?><?php if ($index > 0): ?> → <?php endif; ?><?= printEscape($classificationMarkers[$key] ?? ($key === 'suboperation_l2' && $item['is_placeholder'] ? 'Неизвестно (ID: ' . $item['suboperation_id'] . ')' : ($item[$key] ?? '—'))) ?><?php endforeach; ?></td>
            <td class="memo"><?= printEscape($item['memo'] ?? '—') ?></td>
            <td class="operation-check" data-check-owner="user"><?= $item['is_checked_user'] ? 'П✓' : '' ?></td>
            <td class="operation-check" data-check-owner="admin"><?= $item['is_checked_superuser'] ? 'А✓' : '' ?></td>
            <td class="money"><?= $item['is_debit'] ? printEscape(printMoney($item['amount'])) : '—' ?></td>
            <td class="money"><?= !$item['is_debit'] ? printEscape(printMoney($item['amount'])) : '—' ?></td>
        </tr>
        <?php endforeach; ?>
        <?php if (!$report['items']): ?><tr><td colspan="8">Нет операций за выбранный период</td></tr><?php endif; ?>
        </tbody>
    </table>
    </div>
    <h2>Итоги и сальдо по валютам</h2>
    <div class="table-scroll">
    <table class="totals">
        <thead><tr><th scope="col">Валюта</th><th class="money" scope="col">Начальное</th><th class="money" scope="col">Приход</th><th class="money" scope="col">Расход</th><th class="money" scope="col">За период</th><th class="money" scope="col">Конечное</th></tr></thead>
        <tbody>
        <?php foreach ($report['summary']['currencies'] as $row): ?>
        <tr><th scope="row"><?= printEscape($row['currency'] ?? '—') ?></th>
            <?php foreach (['opening', 'income', 'expense', 'current', 'closing'] as $key): ?>
            <td class="money"><?= printEscape(printMoney($row[$key])) ?></td>
            <?php endforeach; ?>
        </tr>
        <?php endforeach; ?>
        <?php if (!$report['summary']['currencies']): ?><tr><td colspan="6">Нет данных</td></tr><?php endif; ?>
        </tbody>
    </table>
    </div>
    <p class="report-footnote">Итоги учитывают все указанные фильтры, включая отметки отдельно для прихода и расхода. Валюты не суммируются между собой.</p>
    <?php endif; ?>
    <?php endif; ?>
    <p class="print-controls"><a href="/">Вернуться к операциям</a></p>
</main>
</body>
</html>
