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
    for (const name of Object.keys(lookupFields)) form.elements[name].dataset.value = params.get(name) || '';
}

function filterParams() {
    const params = new URLSearchParams();
    for (const element of form.elements) {
        if (!element.name) continue;
        if (element.type === 'checkbox') {
            if (element.checked) params.set(element.name, '1');
        } else if (element.value || element.type === 'date') {
            params.set(element.name, element.value);
        }
    }
    return params;
}

function updateUrl(params) {
    history.replaceState(null, '', params.size ? `?${params}` : location.pathname);
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
    if (!select.value && records.length === 1) select.value = records[0].id;
    delete select.dataset.value;
}

function clearDescendants(name) {
    const order = ['direction_id', 'action_type_id', 'suboperation_l1_id', 'suboperation_l2_id'];
    const index = order.indexOf(name);
    for (const child of order.slice(index + 1)) form.elements[child].value = '';
}

function refreshCascade(from = 'direction_id') {
    const order = ['direction_id', 'action_type_id', 'suboperation_l1_id', 'suboperation_l2_id'];
    for (const name of order.slice(Math.max(0, order.indexOf(from)))) fillSelect(name);
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
    document.querySelector('#currency-summary').innerHTML = summaryTable(data.currencies);
}

function summaryTable(rows) {
    const body = rows.map(row => `<tr>
        <td>${escapeHtml(row.currency)}</td>
        <td>${money.format(row.opening)}</td>
        <td class="summary-table__value--income">${money.format(row.income)}</td>
        <td class="summary-table__value--expense">${money.format(row.expense)}</td>
        <td>${money.format(row.current)}</td>
        <td class="summary-table__value--strong">${money.format(row.closing)}</td>
    </tr>`).join('');
    return `<table class="summary-table"><thead><tr><th>Валюта</th><th>Начальное</th><th>Приход</th><th>Расход</th><th>За период</th><th>Конечное</th></tr></thead><tbody>${body || '<tr><td colspan="6">Нет данных</td></tr>'}</tbody></table>`;
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
    if (records.length === 1) select.value = records[0].id;
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

function openOperation(item = null, isDebit = true) {
    operationForm.reset();
    operationForm.querySelector('[name="id"]').value = item?.id || '';
    operationForm.elements.action_date.value = item?.action_date
        ? String(item.action_date).replace(' ', 'T').slice(0, 16)
        : localDateTime();
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
        refreshCascade('action_type_id');
    }
    refresh();
});
document.querySelector('#reset-filters').addEventListener('click', () => {
    form.reset();
    const [from, to] = defaultDates();
    form.elements.from_date.value = from;
    form.elements.to_date.value = to;
    for (const name of Object.keys(lookupFields)) form.elements[name].value = '';
    refreshCascade();
    refresh();
});

bindLogout(() => currentUser.csrf_token);

document.querySelector('#data-schema').addEventListener('change', async event => {
    event.target.disabled = true;
    document.querySelector('#filter-fields').disabled = true;
    for (const button of document.querySelectorAll('[data-add-flow]')) button.disabled = true;
    try {
        await fetchJson('/api/schema', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': currentUser.csrf_token },
            body: JSON.stringify({ data_schema: event.target.value }),
        });
        currentUser.data_schema = event.target.value;
        lookups = await fetchJson('/api/lookups');
        fillSelect('account_id');
        fillSelect('currency_id');
        refreshCascade();
        document.querySelector('#filter-fields').disabled = false;
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
        for (const button of document.querySelectorAll('[data-add-flow]')) button.disabled = false;
        refresh();
    } catch (error) {
        status.textContent = error.message;
    } finally {
        document.querySelector('#data-schema').disabled = false;
    }
}

init();
