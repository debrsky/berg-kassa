const referenceConfigs = {
    accounts: { parent: ['currency_id', 'currencies', 'Валюта'], memo: true },
    currencies: { memo: true },
    currency_rates: { parent: ['currency_id', 'currencies', 'Валюта'], rate: true },
    directions: { memo: true },
    action_types: { parent: ['direction_id', 'directions', 'Направление'], memo: true },
    suboperations_l1: { parent: ['action_type_id', 'action_types', 'Операция'], memo: true },
    suboperations_l2: { parent: ['suboperation_l1_id', 'suboperations_l1', 'Подоперация 1'], memo: true },
};

const status = document.querySelector('#status');
const manager = document.querySelector('.reference-manager');
const referenceType = document.querySelector('#reference-type');
const referenceList = document.querySelector('#reference-list');
const referenceForm = document.querySelector('#reference-form');
const referenceMessage = document.querySelector('#reference-message');
const hierarchy = document.querySelector('#reference-hierarchy');
const hierarchyDirection = document.querySelector('#hierarchy-direction');
const hierarchyColumns = [...document.querySelectorAll('[data-hierarchy-type]')];
let currentUser;
let lookups = {};
let referenceRecords = [];
let activeReferenceType = '';
let requestVersion = 0;

async function fetchJson(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
    const data = await response.json();
    if (response.status === 401) {
        location.replace('/login');
        throw new Error('Требуется вход');
    }
    if (!response.ok) throw new Error(data.error || 'Ошибка загрузки');
    return data;
}

function localDateTime(value = new Date()) {
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function formatDate(value) {
    return value ? new Intl.DateTimeFormat('ru-RU').format(new Date(value.replace(' ', 'T'))) : '—';
}

function currentType() {
    return referenceType.value === 'operation_tree' ? activeReferenceType : referenceType.value;
}

function referenceLabel(record, type = currentType()) {
    if (type === 'currency_rates') {
        const currency = lookups.currencies.find(item => String(item.id) === String(record.currency_id));
        return `${currency?.name || `ID валюты: ${record.currency_id}`} · ${formatDate(record.rate_date)} · ${record.rate}`;
    }
    return `${record.name || 'Без названия'} (ID: ${record.id})`;
}

function configureReferenceForm() {
    const config = referenceConfigs[currentType()];
    referenceForm.hidden = !config;
    if (!config) return;
    document.querySelector('#reference-parent-field').hidden = !config.parent;
    document.querySelector('#reference-name-field').hidden = Boolean(config.rate);
    document.querySelector('#reference-memo-field').hidden = !config.memo;
    document.querySelector('#reference-date-field').hidden = !config.rate;
    document.querySelector('#reference-rate-field').hidden = !config.rate;
    referenceForm.elements.name.required = !config.rate;
    referenceForm.elements.rate_date.required = Boolean(config.rate);
    referenceForm.elements.rate.required = Boolean(config.rate);
    referenceForm.elements.parent_id.required = Boolean(config.parent);
    if (config.parent) {
        const [, source, label] = config.parent;
        document.querySelector('#reference-parent-label').textContent = label;
        referenceForm.elements.parent_id.replaceChildren(new Option('Выберите', ''));
        for (const item of lookups[source] || []) referenceForm.elements.parent_id.add(new Option(item.name || `ID: ${item.id}`, item.id));
    }
}

function editReference(record = null, type = currentType(), parentId = '') {
    if (!currentUser?.can_view_protected) return;
    activeReferenceType = type;
    referenceForm.reset();
    configureReferenceForm();
    referenceForm.querySelector('[name="id"]').value = record?.id || '';
    referenceForm.elements.name.value = record?.name ?? '';
    referenceForm.elements.memo.value = record?.memo ?? '';
    const config = referenceConfigs[type];
    if (config.parent) referenceForm.elements.parent_id.value = record?.[config.parent[0]] ?? parentId;
    if (config.rate) {
        referenceForm.elements.rate_date.value = record?.rate_date ? String(record.rate_date).replace(' ', 'T').slice(0, 16) : localDateTime();
        referenceForm.elements.rate.value = record?.rate ?? '';
    }
    document.querySelector('#delete-reference').hidden = !record;
    referenceMessage.textContent = '';
}

function hierarchyColumn(type) {
    return hierarchyColumns.find(column => column.dataset.hierarchyType === type);
}

function renderHierarchy() {
    for (const column of hierarchyColumns) {
        const type = column.dataset.hierarchyType;
        const config = referenceConfigs[type];
        const parentId = type === 'action_types'
            ? hierarchyDirection.value
            : hierarchyColumn(type === 'suboperations_l1' ? 'action_types' : 'suboperations_l1').querySelector('[data-hierarchy-list]').value;
        const search = column.querySelector('[data-hierarchy-search]').value.toLocaleLowerCase('ru');
        const list = column.querySelector('[data-hierarchy-list]');
        const previous = list.value;
        const records = (lookups[type] || []).filter(record =>
            String(record[config.parent[0]]) === String(parentId) &&
            (record.name || '').toLocaleLowerCase('ru').includes(search)
        );
        list.replaceChildren(...records.map(record => new Option(referenceLabel(record, type), record.id)));
        if (records.some(record => String(record.id) === previous)) list.value = previous;
    }
}

function selectHierarchyRecord(type, id) {
    const record = (lookups[type] || []).find(item => String(item.id) === String(id));
    if (record) editReference(record, type);
}

function loadHierarchy(selected = null) {
    hierarchyDirection.replaceChildren(...(lookups.directions || []).map(item => new Option(item.name, item.id)));
    let actionId = '';
    let sub1Id = '';
    if (selected?.type === 'action_types') hierarchyDirection.value = selected.record.direction_id;
    if (selected?.type === 'suboperations_l1') {
        actionId = selected.record.action_type_id;
        hierarchyDirection.value = lookups.action_types.find(item => String(item.id) === String(actionId))?.direction_id || '';
    }
    if (selected?.type === 'suboperations_l2') {
        sub1Id = selected.record.suboperation_l1_id;
        actionId = lookups.suboperations_l1.find(item => String(item.id) === String(sub1Id))?.action_type_id || '';
        hierarchyDirection.value = lookups.action_types.find(item => String(item.id) === String(actionId))?.direction_id || '';
    }
    renderHierarchy();
    if (actionId) {
        hierarchyColumn('action_types').querySelector('[data-hierarchy-list]').value = actionId;
        renderHierarchy();
    }
    if (sub1Id) {
        hierarchyColumn('suboperations_l1').querySelector('[data-hierarchy-list]').value = sub1Id;
        renderHierarchy();
    }
    if (selected) {
        hierarchyColumn(selected.type).querySelector('[data-hierarchy-list]').value = selected.record.id;
        editReference(selected.record, selected.type);
    } else {
        activeReferenceType = '';
        referenceForm.hidden = true;
        referenceMessage.textContent = 'Выберите запись или добавьте новую';
    }
}

async function loadReferences(selectedId = '') {
    const version = ++requestVersion;
    const treeMode = referenceType.value === 'operation_tree';
    manager.classList.toggle('reference-manager--hierarchy', treeMode);
    hierarchy.hidden = !treeMode;
    document.querySelector('#reference-list-field').hidden = treeMode;
    document.querySelector('#new-reference').hidden = treeMode;
    if (treeMode) {
        loadHierarchy();
        return;
    }
    activeReferenceType = referenceType.value;
    referenceMessage.textContent = 'Загрузка…';
    try {
        const records = await fetchJson(`/api/references/${currentType()}`);
        if (version !== requestVersion) return;
        referenceRecords = records;
        referenceList.replaceChildren(...referenceRecords.map(record => new Option(referenceLabel(record), record.id)));
        const selected = referenceRecords.find(record => String(record.id) === String(selectedId));
        if (selected) referenceList.value = selected.id;
        editReference(selected || null);
        referenceMessage.textContent = referenceRecords.length ? '' : 'Записей пока нет';
    } catch (error) {
        if (version === requestVersion) referenceMessage.textContent = error.message;
    }
}

referenceType.addEventListener('change', () => loadReferences());
referenceList.addEventListener('change', () => editReference(referenceRecords.find(record => String(record.id) === referenceList.value) || null));
document.querySelector('#new-reference').addEventListener('click', () => { referenceList.value = ''; editReference(); });
hierarchyDirection.addEventListener('change', () => {
    renderHierarchy();
    activeReferenceType = '';
    referenceForm.hidden = true;
});

for (const column of hierarchyColumns) {
    const type = column.dataset.hierarchyType;
    const list = column.querySelector('[data-hierarchy-list]');
    const parent = () => type === 'action_types'
        ? hierarchyDirection.value
        : hierarchyColumn(type === 'suboperations_l1' ? 'action_types' : 'suboperations_l1').querySelector('[data-hierarchy-list]').value;
    list.addEventListener('change', () => {
        if (type !== 'suboperations_l2') renderHierarchy();
        activeReferenceType = '';
        referenceForm.hidden = true;
    });
    list.addEventListener('dblclick', () => selectHierarchyRecord(type, list.value));
    column.querySelector('[data-hierarchy-search]').addEventListener('input', renderHierarchy);
    column.querySelector('[data-edit-hierarchy]').addEventListener('click', () => {
        if (list.value) selectHierarchyRecord(type, list.value);
        else referenceMessage.textContent = 'Сначала выберите запись';
    });
    column.querySelector('[data-add-hierarchy]').addEventListener('click', () => editReference(null, type, parent()));
}

referenceForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = referenceForm.querySelector('[type=submit]');
    if (submit.disabled) return;
    submit.disabled = true;
    const type = currentType();
    const config = referenceConfigs[type];
    const id = referenceForm.querySelector('[name="id"]').value;
    const data = {};
    if (!config.rate) data.name = referenceForm.elements.name.value;
    if (config.memo) data.memo = referenceForm.elements.memo.value;
    if (config.parent) data[config.parent[0]] = referenceForm.elements.parent_id.value;
    if (config.rate) {
        data.rate_date = referenceForm.elements.rate_date.value;
        data.rate = referenceForm.elements.rate.value;
    }
    referenceMessage.textContent = 'Сохранение…';
    try {
        const saved = await fetchJson(`/api/references/${type}${id ? `/${id}` : ''}`, {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': currentUser.csrf_token },
            body: JSON.stringify(data),
        });
        lookups = await fetchJson('/api/lookups');
        if (referenceType.value === 'operation_tree') {
            const record = lookups[type].find(item => String(item.id) === String(saved.id));
            loadHierarchy({ type, record });
        } else await loadReferences(saved.id);
        referenceMessage.textContent = 'Сохранено';
    } catch (error) {
        referenceMessage.textContent = error.message;
    } finally {
        submit.disabled = false;
    }
});

document.querySelector('#delete-reference').addEventListener('click', async () => {
    const type = currentType();
    const id = referenceForm.querySelector('[name="id"]').value;
    if (!id || !confirm('Удалить запись справочника без возможности восстановления?')) return;
    referenceMessage.textContent = 'Удаление…';
    try {
        await fetchJson(`/api/references/${type}/${id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': currentUser.csrf_token } });
        lookups = await fetchJson('/api/lookups');
        await loadReferences();
        referenceMessage.textContent = 'Удалено';
    } catch (error) {
        referenceMessage.textContent = error.message;
    }
});

document.querySelector('#data-schema').addEventListener('change', async event => {
    event.target.disabled = true;
    manager.inert = true;
    ++requestVersion;
    try {
        await fetchJson('/api/schema', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': currentUser.csrf_token },
            body: JSON.stringify({ data_schema: event.target.value }),
        });
        currentUser.data_schema = event.target.value;
        lookups = await fetchJson('/api/lookups');
        await loadReferences();
        status.textContent = `Схема ${currentUser.data_schema}`;
    } catch (error) {
        status.textContent = error.message;
    } finally {
        event.target.disabled = false;
        manager.inert = false;
    }
});

document.querySelector('#logout').addEventListener('click', async () => {
    try {
        await fetchJson('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': currentUser.csrf_token } });
        location.replace('/login');
    } catch (error) {
        status.textContent = error.message;
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
        if (unavailable.has(currentUser.data_schema)) {
            status.textContent = `Схема ${currentUser.data_schema} отсутствует. Выберите другую схему.`;
            return;
        }
        lookups = await fetchJson('/api/lookups');
        await loadReferences();
        manager.inert = false;
        status.textContent = `Схема ${currentUser.data_schema}`;
    } catch (error) {
        status.textContent = error.message;
    } finally {
        document.querySelector('#data-schema').disabled = false;
    }
}

init();
