const ROW_HEIGHT = 58;
const BUFFER = 8;
const PAGE_SIZE = 100;
const MAX_CACHED_PAGES = 20;
const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat('ru-RU');

const form = document.querySelector('#filters');
const status = document.querySelector('#status');
const notePopover = document.querySelector('#note-popover');
const operationDialog = document.querySelector('#operation-dialog');
const operationForm = document.querySelector('#operation-form');
const lookupFields = {
    account_id: ['accounts'],
    currency_id: ['currencies'],
    direction_id: ['directions'],
    action_type_id: ['action_types', 'direction_id'],
    suboperation_l1_id: ['suboperations_l1', 'action_type_id'],
    suboperation_l2_id: ['suboperations_l2', 'suboperation_l1_id'],
};
let lookups = {};
let requestVersion = 0;
let memoTimer;
let appliedFilters = new URLSearchParams();
let currentUser;
const checkFilters = {
    income: { checked_user: '', checked_superuser: '' },
    expense: { checked_user: '', checked_superuser: '' },
};

const lists = [...document.querySelectorAll('.operation-panel')].map(panel => new VirtualList(panel));

function selectOperationsTab(flow) {
    sessionStorage.setItem('operations-tab', flow);
    for (const tab of document.querySelectorAll('[data-flow-tab]')) {
        const active = tab.dataset.flowTab === flow;
        tab.classList.toggle('operations-tabs__tab--active', active);
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
    }
    for (const list of lists) {
        list.panel.classList.toggle('operation-panel--active', list.flow === flow);
        if (list.flow === flow) list.render();
    }
    syncCheckFilters();
}

const tabs = [...document.querySelectorAll('[data-flow-tab]')];
for (const tab of tabs) {
    tab.addEventListener('click', () => selectOperationsTab(tab.dataset.flowTab));
    tab.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        selectOperationsTab(next.dataset.flowTab);
        next.focus();
    });
}
selectOperationsTab(sessionStorage.getItem('operations-tab') === 'expense' ? 'expense' : 'income');

let swipeStart;
const operationsBoard = document.querySelector('.operations-board');
operationsBoard.addEventListener('pointerdown', event => {
    if (innerWidth > 479 || event.target.closest('button, a, input, select, textarea, .operation-row__note')) return;
    swipeStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
    try { operationsBoard.setPointerCapture(event.pointerId); } catch {}
});
operationsBoard.addEventListener('pointerup', event => {
    if (!swipeStart || event.pointerId !== swipeStart.id) return;
    const dx = event.clientX - swipeStart.x;
    const dy = event.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) < 60 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
    selectOperationsTab(dx < 0 ? 'expense' : 'income');
});
operationsBoard.addEventListener('pointercancel', () => { swipeStart = null; });

function presetDates(preset, now = new Date()) {
    const start = new Date(now);
    const end = new Date(now);
    switch (preset) {
        case 'all': return ['', ''];
        case 'yesterday': start.setDate(start.getDate() - 1); end.setDate(end.getDate() - 1); break;
        case 'week': start.setDate(start.getDate() - (start.getDay() + 6) % 7); break;
        case 'month': start.setDate(1); break;
        case 'previous-month': start.setDate(1); start.setMonth(start.getMonth() - 1); end.setDate(0); break;
        case 'last30': start.setDate(start.getDate() - 29); break;
    }
    return [isoDate(start), isoDate(end)];
}

function defaultDates() {
    return presetDates('last30');
}

function restoreFilters() {
    const params = new URLSearchParams(location.search);
    const [from, to] = defaultDates();
    form.elements.memo.value = params.get('memo') ?? '';
    form.elements.from_date.value = params.get('from_date') ?? from;
    form.elements.to_date.value = params.get('to_date') ?? to;
    if (!form.elements.from_date.value && !form.elements.to_date.value) document.querySelector('#period-preset').value = 'all';
    form.elements.include_protected.checked = params.get('include_protected') === '1';
    for (const flow of ['income', 'expense']) {
        for (const name of ['checked_user', 'checked_superuser']) {
            checkFilters[flow][name] = params.get(`${flow}_${name}`) ?? '';
        }
    }
    for (const name of Object.keys(lookupFields)) form.elements[name].dataset.value = params.get(name) || '';
    syncCheckFilters();
}

function syncCheckFilters() {
    const states = { '': ['—', 'Все'], '1': ['✓', 'Поставлена'], '0': ['□', 'Не поставлена'] };
    for (const button of document.querySelectorAll('[data-check-filter]')) {
        const name = button.dataset.checkFilter;
        const value = checkFilters[button.dataset.filterFlow][name];
        const [symbol, label] = states[value];
        const owner = name === 'checked_user' ? 'пользователя' : 'суперпользователя';
        button.value = value;
        button.textContent = symbol;
        button.title = `Отметка ${owner}: ${label}`;
        button.setAttribute('aria-label', `Фильтр по отметке ${owner}: ${label}. Нажмите, чтобы переключить`);
    }
    const activeFlow = document.querySelector('.operations-tabs__tab--active')?.dataset.flowTab || 'income';
    for (const name of ['checked_user', 'checked_superuser']) form.elements[name].value = checkFilters[activeFlow][name];
}

for (const button of document.querySelectorAll('[data-check-filter]')) {
    button.addEventListener('click', () => {
        const values = ['', '1', '0'];
        checkFilters[button.dataset.filterFlow][button.dataset.checkFilter] = values[(values.indexOf(button.value) + 1) % values.length];
        syncCheckFilters();
        refresh();
    });
}

function filterParams() {
    const params = new URLSearchParams();
    for (const element of form.elements) {
        if (!element.name) continue;
        if (['checked_user', 'checked_superuser'].includes(element.name)) continue;
        if (element.type === 'checkbox') {
            if (element.checked) params.set(element.name, '1');
        } else if (element.value || element.type === 'date') {
            params.set(element.name, element.value);
        }
    }
    for (const flow of ['income', 'expense']) {
        for (const name of ['checked_user', 'checked_superuser']) {
            if (checkFilters[flow][name]) params.set(`${flow}_${name}`, checkFilters[flow][name]);
        }
    }
    return params;
}

function updateUrl(params) {
    history.replaceState(null, '', params.size ? `?${params}` : location.pathname);
}

function automaticRecord(records, allowDashes = true) {
    return (allowDashes && records.find(item => /^-+$/.test(item.name))) || (records.length === 1 ? records[0] : null);
}

function fillSelect(name) {
    const select = form.elements[name];
    const [source, parent] = lookupFields[name];
    const selected = select.dataset.value ?? select.value;
    const parentValue = parent ? form.elements[parent].value : '';
    const records = (lookups[source] || []).filter(item => !parent || String(item[parent]) === parentValue);
    select.disabled = Boolean(parent && !parentValue);
    select.replaceChildren(new Option(select.disabled ? 'Сначала выберите уровень выше' : 'Все', ''));
    for (const item of records) {
        const label = item.is_placeholder ? `Неизвестно (ID: ${item.id})` : (item.name || `ID: ${item.id}`);
        select.add(new Option(label, item.id));
    }
    select.value = records.some(item => String(item.id) === selected) ? selected : '';
    if (!select.value) select.value = automaticRecord(records, name !== 'direction_id')?.id ?? '';
    delete select.dataset.value;
}

function clearDescendants(name) {
    const order = ['direction_id', 'action_type_id', 'suboperation_l1_id', 'suboperation_l2_id'];
    const index = order.indexOf(name);
    for (const child of order.slice(index + 1)) form.elements[child].value = '';
}

function refreshCascade(from = 'direction_id', includeSelf = true) {
    const order = ['direction_id', 'action_type_id', 'suboperation_l1_id', 'suboperation_l2_id'];
    const start = Math.max(0, order.indexOf(from)) + (includeSelf ? 0 : 1);
    for (const name of order.slice(start)) fillSelect(name);
}

async function refresh() {
    clearTimeout(memoTimer);
    const from = form.elements.from_date;
    const to = form.elements.to_date;
    to.setCustomValidity(from.value && to.value && from.value > to.value ? 'Начало периода не может быть позже конца' : '');
    if (!form.reportValidity()) return;
    requestVersion++;
    const version = requestVersion;
    appliedFilters = filterParams();
    updateFilterToggle();
    updateUrl(appliedFilters);
    status.textContent = 'Обновление…';
    lists.forEach(list => list.reset());
    try {
        const data = await fetchJson(`/api/action-summary?${appliedFilters}`);
        if (version !== requestVersion) return;
        renderSummary(data);
        status.textContent = `Найдено ${Number(data.operation_count).toLocaleString('ru-RU')} операций`;
    } catch (error) {
        if (version === requestVersion) status.textContent = error.message;
    }
}

function renderSummary(data) {
    const container = document.querySelector('#currency-summary');
    const wasOpen = container.querySelector('.summary-compact__details')?.open ?? false;
    container.innerHTML = summaryTable(data.currencies) + summaryCompact(data.currencies);
    const details = container.querySelector('.summary-compact__details');
    if (!details) return;
    details.open = wasOpen;
    const tabs = [...container.querySelectorAll('[data-summary-tab]')];
    const activate = tab => {
        for (const button of tabs) {
            const active = button === tab;
            button.setAttribute('aria-selected', String(active));
            button.tabIndex = active ? 0 : -1;
        }
        for (const element of container.querySelectorAll('[data-summary-index]')) element.hidden = element.dataset.summaryIndex !== tab.dataset.summaryTab;
        sessionStorage.setItem('summary-currency', tab.dataset.currency);
    };
    for (const tab of tabs) {
        tab.addEventListener('click', () => activate(tab));
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
            event.preventDefault();
            const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
            activate(next);
            next.focus();
        });
    }
    activate(tabs.find(tab => tab.dataset.currency === sessionStorage.getItem('summary-currency')) || tabs[0]);
}

function summaryTable(rows) {
    const incomeHeading = summaryFlowHeading('Приход', 'income');
    const expenseHeading = summaryFlowHeading('Расход', 'expense');
    const body = rows.map(row => `<tr>
        <td data-label="Валюта">${escapeHtml(row.currency)}</td>
        <td data-label="Начальное">${money.format(row.opening)}</td>
        <td data-label="Приход" class="summary-table__value--income">${money.format(row.income)}</td>
        <td data-label="Расход" class="summary-table__value--expense">${money.format(row.expense)}</td>
        <td data-label="За период">${money.format(row.current)}</td>
        <td data-label="Конечное" class="summary-table__value--strong">${money.format(row.closing)}</td>
    </tr>`).join('');
    return `<table class="summary-table"><thead><tr><th>Валюта</th><th>Начальное</th><th>${incomeHeading}</th><th>${expenseHeading}</th><th>За период</th><th>Конечное</th></tr></thead><tbody>${body || '<tr><td colspan="6">Нет данных</td></tr>'}</tbody></table>`;
}

function summaryFlowHeading(label, flow) {
    return Object.values(checkFilters[flow]).some(Boolean)
        ? `${label}<small class="summary-filter-note">с учётом отметок</small>`
        : label;
}

function formatDate(value) {
    return value ? date.format(new Date(value.replace(' ', 'T'))) : '—';
}

function isoDate(value) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function escapeHtml(value) {
    const element = document.createElement('span');
    element.textContent = value ?? '—';
    return element.innerHTML;
}

function showNote(note, text) {
    notePopover.querySelector('[data-note-text]').textContent = text;
    notePopover.style.visibility = 'hidden';
    notePopover.style.left = '0';
    notePopover.style.top = '0';
    if (!notePopover.matches(':popover-open')) notePopover.showPopover();

    const anchor = note.getBoundingClientRect();
    const box = notePopover.getBoundingClientRect();
    const gap = 8;
    const left = Math.min(Math.max(gap, anchor.left), innerWidth - box.width - gap);
    const below = anchor.bottom + gap;
    const top = below + box.height <= innerHeight ? below : Math.max(gap, anchor.top - box.height - gap);
    notePopover.style.left = `${left}px`;
    notePopover.style.top = `${top}px`;
    notePopover.style.visibility = 'visible';
}

function editorOptions(name, source, parentName, parentField) {
    const select = operationForm.elements[name];
    const parentValue = parentName ? operationForm.elements[parentName].value : '';
    const records = (lookups[source] || []).filter(item => !parentName || String(item[parentField]) === parentValue);
    select.disabled = Boolean(parentName && !parentValue);
    select.replaceChildren(new Option(select.disabled ? 'Сначала выберите уровень выше' : 'Выберите', ''));
    for (const item of records) {
        const label = item.is_placeholder ? `Неизвестно (ID: ${item.id})` : (item.name || `ID: ${item.id}`);
        select.add(new Option(label, item.id));
    }
    select.value = automaticRecord(records, name !== 'direction_id')?.id ?? '';
}

function refreshEditorCascade(from = 'direction_id') {
    const fields = [
        ['direction_id', 'directions'],
        ['action_type_id', 'action_types', 'direction_id', 'direction_id'],
        ['suboperation_l1_id', 'suboperations_l1', 'action_type_id', 'action_type_id'],
        ['suboperation_id', 'suboperations_l2', 'suboperation_l1_id', 'suboperation_l1_id'],
    ];
    const start = Math.max(0, fields.findIndex(([name]) => name === from));
    for (const field of fields.slice(start)) editorOptions(...field);
}

function localDateTime(value = new Date()) {
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function newOperationDateTime() {
    const now = localDateTime();
    const today = now.slice(0, 10);
    const from = appliedFilters.get('from_date');
    const to = appliedFilters.get('to_date');
    if (to && ((from && today < from) || today > to)) {
        return to + 'T00:00';
    }
    return now;
}

function openOperation(item = null, isDebit = true) {
    operationForm.reset();
    for (const control of operationForm.querySelectorAll('input, select, textarea')) control.disabled = false;
    operationForm.querySelector('[name="id"]').value = item?.id || '';
    operationForm.elements.action_date.value = item?.action_date
        ? String(item.action_date).replace(' ', 'T').slice(0, 16)
        : newOperationDateTime();
    operationForm.elements.is_debit.value = String(item?.is_debit ?? isDebit);
    operationForm.elements.amount.value = item?.amount ?? '';
    operationForm.elements.memo.value = item?.memo ?? '';
    operationForm.elements.is_black.checked = item ? Boolean(item.is_black) : form.elements.include_protected.checked;
    operationForm.elements.account_id.replaceChildren(new Option('Выберите', ''));
    operationForm.elements.currency_id.replaceChildren(new Option('Выберите', ''));
    operationForm.elements.posting_account_id.replaceChildren(new Option('Выберите', ''));
    for (const record of lookups.accounts) operationForm.elements.account_id.add(new Option(record.name || `ID: ${record.id}`, record.id));
    for (const record of lookups.currencies) operationForm.elements.currency_id.add(new Option(record.name || `ID: ${record.id}`, record.id));
    for (const record of lookups.accounts) operationForm.elements.posting_account_id.add(new Option(record.name || `ID: ${record.id}`, record.id));
    operationForm.elements.account_id.value = item?.account_id ?? form.elements.account_id.value;
    const currencyId = item?.currency_id ?? form.elements.currency_id.value;
    const currency = lookups.currencies.find(record => String(record.id) === String(currencyId))
        ?? (!item && lookups.currencies.find(record => record.name === 'р.'));
    operationForm.elements.currency_id.value = currency?.id ?? '';
    operationForm.elements.exchange_rate.value = item?.exchange_rate ?? currency?.default_rate ?? '';
    refreshEditorCascade();
    if (item) {
        const sub2 = lookups.suboperations_l2.find(record => String(record.id) === String(item.suboperation_id));
        const sub1 = lookups.suboperations_l1.find(record => String(record.id) === String(sub2?.suboperation_l1_id));
        const actionType = lookups.action_types.find(record => String(record.id) === String(sub1?.action_type_id));
        operationForm.elements.direction_id.value = actionType?.direction_id ?? '';
        refreshEditorCascade('action_type_id');
        operationForm.elements.action_type_id.value = sub1?.action_type_id ?? '';
        refreshEditorCascade('suboperation_l1_id');
        operationForm.elements.suboperation_l1_id.value = sub2?.suboperation_l1_id ?? '';
        refreshEditorCascade('suboperation_id');
        operationForm.elements.suboperation_id.value = item.suboperation_id;
    } else {
        for (const [filterName, fieldName, next] of [
            ['direction_id', 'direction_id', 'action_type_id'],
            ['action_type_id', 'action_type_id', 'suboperation_l1_id'],
            ['suboperation_l1_id', 'suboperation_l1_id', 'suboperation_id'],
            ['suboperation_l2_id', 'suboperation_id'],
        ]) {
            if (form.elements[filterName].value) operationForm.elements[fieldName].value = form.elements[filterName].value;
            if (next) refreshEditorCascade(next);
        }
    }
    editorOptions('posting_suboperation_id', 'suboperations_l2', 'suboperation_l1_id', 'suboperation_l1_id');
    document.querySelector('#operation-posting').hidden = Boolean(item);
    document.querySelector('#operation-posting').open = false;
    operationForm.elements.posting_account_id.required = false;
    operationForm.elements.posting_suboperation_id.required = false;
    document.querySelector('#operation-form-title').textContent = item ? 'Редактирование операции' : 'Новая операция';
    document.querySelector('#delete-operation').hidden = !item;
    document.querySelector('#operation-form-error').textContent = '';
    const from = currentUser.operation_edit_from;
    const locked = Boolean(item && from && String(item.action_date).slice(0, 10) < from);
    operationForm.elements.action_date.min = from ? from + 'T00:00' : '';
    operationForm.querySelector('[type="submit"]').disabled = locked;
    document.querySelector('#delete-operation').disabled = locked;
    if (locked) {
        for (const control of operationForm.querySelectorAll('input, select, textarea')) control.disabled = true;
        document.querySelector('#operation-form-title').textContent = 'Просмотр операции';
        document.querySelector('#operation-form-error').textContent = 'Изменения операций доступны с ' + from.split('-').reverse().join('.') + '.';
    }
    operationDialog.showModal();
}

for (const name of ['direction_id', 'action_type_id', 'suboperation_l1_id']) {
    operationForm.elements[name].addEventListener('change', () => {
        const next = { direction_id: 'action_type_id', action_type_id: 'suboperation_l1_id', suboperation_l1_id: 'suboperation_id' }[name];
        refreshEditorCascade(next);
        editorOptions('posting_suboperation_id', 'suboperations_l2', 'suboperation_l1_id', 'suboperation_l1_id');
    });
}

operationForm.elements.currency_id.addEventListener('change', event => {
    const currency = lookups.currencies.find(item => String(item.id) === event.target.value);
    operationForm.elements.exchange_rate.value = currency?.default_rate ?? '';
});

document.querySelector('#operation-posting').addEventListener('toggle', event => {
    operationForm.elements.posting_account_id.required = event.target.open;
    operationForm.elements.posting_suboperation_id.required = event.target.open;
});

for (const button of document.querySelectorAll('[data-add-flow]')) {
    button.addEventListener('click', () => openOperation(null, button.dataset.addFlow === 'income'));
}

function summaryCompact(rows) {
    if (!rows.length) return '<p class="summary-compact">Нет данных</p>';
    const tabs = rows.map((row, index) => `<button type="button" role="tab" data-summary-tab="${index}" data-currency="${escapeHtml(row.currency)}">${escapeHtml(row.currency)}</button>`).join('');
    const headlines = rows.map((row, index) => `<span class="summary-compact__headline" data-summary-index="${index}">
        <span>${escapeHtml(row.currency)}</span>
        <strong>${summaryMoney(row.closing, row.currency)}</strong>
        <small>За период: ${summaryMoney(row.current, row.currency, true)}</small>
    </span>`).join('');
    const panels = rows.map((row, index) => `<dl class="summary-compact__breakdown" data-summary-index="${index}">
        <dt>Начальное</dt><dd>${summaryMoney(row.opening, row.currency)}</dd>
        <dt>${summaryFlowHeading('Приход', 'income')}</dt><dd class="summary-table__value--income">${summaryMoney(row.income, row.currency)}</dd>
        <dt>${summaryFlowHeading('Расход', 'expense')}</dt><dd class="summary-table__value--expense">${summaryMoney(row.expense, row.currency)}</dd>
        <dt>За период</dt><dd>${summaryMoney(row.current, row.currency, true)}</dd>
        <dt>Конечное</dt><dd class="summary-table__value--strong">${summaryMoney(row.closing, row.currency)}</dd>
    </dl>`).join('');
    return `<div class="summary-compact"><div class="summary-compact__tabs" role="tablist" aria-label="Валюта итогов">${tabs}</div>
        <details class="summary-compact__details"><summary>${headlines}</summary>${panels}</details></div>`;
}

function summaryMoney(value, currency, signed = false) {
    const number = Number(value);
    return `${signed && number > 0 ? '+' : ''}${money.format(number)} ${escapeHtml(currency)}`;
}
for (const button of document.querySelectorAll('[data-close-dialog]')) {
    button.addEventListener('click', () => operationDialog.close());
}

operationForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = operationForm.querySelector('[type="submit"]');
    if (submit.disabled) return;
    const data = Object.fromEntries(new FormData(operationForm));
    data.is_debit = data.is_debit === 'true';
    data.is_black = operationForm.elements.is_black.checked;
    if (document.querySelector('#operation-posting').open) {
        data.posting = {
            account_id: data.posting_account_id,
            suboperation_id: data.posting_suboperation_id,
        };
    }
    delete data.posting_account_id;
    delete data.posting_suboperation_id;
    const id = data.id;
    delete data.id;
    submit.disabled = true;
    try {
        await fetchJson(id ? `/api/actions/${id}` : '/api/actions', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': currentUser.csrf_token },
            body: JSON.stringify(data),
        });
        operationDialog.close();
        await refresh();
    } catch (error) {
        document.querySelector('#operation-form-error').textContent = error.message;
    } finally {
        submit.disabled = false;
    }
});

document.querySelector('#delete-operation').addEventListener('click', async () => {
    const id = operationForm.querySelector('[name="id"]').value;
    if (!id || !confirm('Удалить операцию без возможности восстановления?')) return;
    try {
        await fetchJson(`/api/actions/${id}`, {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': currentUser.csrf_token },
        });
        operationDialog.close();
        await refresh();
    } catch (error) {
        document.querySelector('#operation-form-error').textContent = error.message;
    }
});

form.addEventListener('submit', event => {
    event.preventDefault();
    refresh();
});
form.elements.memo.addEventListener('input', () => {
    clearTimeout(memoTimer);
    if (!form.elements.memo.value) refresh();
    else memoTimer = setTimeout(refresh, 400);
});
form.elements.memo.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
        event.preventDefault();
        refresh();
    }
});
form.addEventListener('change', event => {
    if (event.target === form.elements.memo) return;
    const preset = document.querySelector('#period-preset');
    if (event.target === preset) {
        if (!preset.value) return;
        [form.elements.from_date.value, form.elements.to_date.value] = presetDates(preset.value);
    } else if (['from_date', 'to_date'].includes(event.target.name)) {
        if (!event.target.value) event.target.value = '';
        preset.value = '';
    }
    const hierarchy = ['direction_id', 'action_type_id', 'suboperation_l1_id', 'suboperation_l2_id'];
    if (hierarchy.includes(event.target.name)) {
        clearDescendants(event.target.name);
        refreshCascade(event.target.name, false);
    }
    if (['checked_user', 'checked_superuser'].includes(event.target.name)) {
        const flow = document.querySelector('.operations-tabs__tab--active').dataset.flowTab;
        checkFilters[flow][event.target.name] = event.target.value;
        syncCheckFilters();
    }
    refresh();
});
function resetFilters() {
    form.reset();
    for (const flow of ['income', 'expense']) for (const name of ['checked_user', 'checked_superuser']) checkFilters[flow][name] = '';
    const [from, to] = defaultDates();
    form.elements.from_date.value = from;
    form.elements.to_date.value = to;
    for (const name of Object.keys(lookupFields)) form.elements[name].value = '';
    refreshCascade();
    syncCheckFilters();
}

document.querySelector('#reset-filters').addEventListener('click', () => {
    resetFilters();
    refresh();
});

const filterToggle = document.querySelector('#filter-toggle');
filterToggle.addEventListener('click', () => {
    const expanded = filterToggle.getAttribute('aria-expanded') !== 'true';
    filterToggle.setAttribute('aria-expanded', String(expanded));
    document.querySelector('#filter-fields').classList.toggle('filter-bar--expanded', expanded);
    updateFilterToggle();
});

function updateFilterToggle() {
    const [defaultFrom, defaultTo] = defaultDates();
    const active = [...form.elements].filter(element => element.name && !['checked_user', 'checked_superuser'].includes(element.name) && (
        element.type === 'checkbox' ? element.checked : element.value &&
        !((element.name === 'from_date' && element.value === defaultFrom) || (element.name === 'to_date' && element.value === defaultTo))
    )).length + Object.values(checkFilters).flatMap(Object.values).filter(Boolean).length;
    const expanded = filterToggle.getAttribute('aria-expanded') === 'true';
    filterToggle.textContent = `${expanded ? 'Скрыть фильтры' : 'Фильтры'}${active ? ` (${active})` : ''} ${expanded ? '▴' : '▾'}`;
}

document.querySelector('#print-actions').addEventListener('click', () => {
    if (!currentUser || document.querySelector('#filter-fields').disabled) return;
    const params = new URLSearchParams(appliedFilters);
    params.set('schema', currentUser.data_schema);
    window.open(`/print/actions?${params}`, '_blank', 'noopener,noreferrer');
});

bindLogout(() => currentUser.csrf_token);

document.querySelector('#data-schema').addEventListener('change', async event => {
    event.target.disabled = true;
    document.querySelector('#print-actions').disabled = true;
    document.querySelector('#filter-fields').disabled = true;
    for (const button of document.querySelectorAll('[data-add-flow]')) button.disabled = true;
    try {
        await fetchJson('/api/schema', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': currentUser.csrf_token },
            body: JSON.stringify({ data_schema: event.target.value }),
        });
        currentUser.data_schema = event.target.value;
        saveDataSchema(currentUser, event.target.value);
        lookups = await fetchJson('/api/lookups');
        resetFilters();
        fillSelect('account_id');
        fillSelect('currency_id');
        document.querySelector('#filter-fields').disabled = false;
        document.querySelector('#print-actions').disabled = false;
        for (const button of document.querySelectorAll('[data-add-flow]')) button.disabled = false;
        refresh();
    } catch (error) {
        status.textContent = error.message;
    } finally {
        event.target.disabled = false;
    }
});

async function init() {
    try {
        currentUser = await fetchJson('/api/me');
        await restoreDataSchema(currentUser);
        document.querySelector('#current-user').textContent = currentUser.login;
        document.querySelector('#audit-link').hidden = !currentUser.can_view_protected;
        document.querySelector('#users-link').hidden = !currentUser.can_view_protected;
        const schemaSelect = document.querySelector('#data-schema');
        const unavailable = new Set(currentUser.unavailable_data_schemas);
        schemaSelect.replaceChildren(...currentUser.data_schemas.map(schema => {
            const option = new Option(unavailable.has(schema) ? `${schema} — недоступна` : schema, schema);
            option.disabled = unavailable.has(schema);
            return option;
        }));
        schemaSelect.value = currentUser.data_schema;
        const protectedField = document.querySelector('#protected-filter');
        if (protectedField) protectedField.hidden = !currentUser.can_view_protected;
        const operationProtectedField = document.querySelector('#operation-protected-field');
        if (operationProtectedField) operationProtectedField.hidden = !currentUser.can_view_protected;
        if (!currentUser.can_view_protected) form.elements.include_protected.checked = false;
        restoreFilters();
        if (!currentUser.can_view_protected) form.elements.include_protected.checked = false;
        if (unavailable.has(currentUser.data_schema)) {
            status.textContent = `Схема ${currentUser.data_schema} отсутствует. Выберите другую схему.`;
            return;
        }
        lookups = await fetchJson('/api/lookups');
        fillSelect('account_id');
        fillSelect('currency_id');
        refreshCascade();
        document.querySelector('#filter-fields').disabled = false;
        document.querySelector('#print-actions').disabled = false;
        for (const button of document.querySelectorAll('[data-add-flow]')) button.disabled = false;
        refresh();
    } catch (error) {
        status.textContent = error.message;
    } finally {
        document.querySelector('#data-schema').disabled = false;
    }
}

init();
