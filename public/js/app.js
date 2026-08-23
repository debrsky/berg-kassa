const ROW_HEIGHT = 58;
const BUFFER = 8;
const money = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = new Intl.DateTimeFormat('ru-RU');

const form = document.querySelector('#filters');
const status = document.querySelector('#status');
const notePopover = document.querySelector('#note-popover');
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
let currentUser;

class VirtualList {
    constructor(panel) {
        this.panel = panel;
        this.flow = panel.dataset.flow;
        this.viewport = panel.querySelector('[data-list]');
        this.canvas = panel.querySelector('[data-canvas]');
        this.count = panel.querySelector('[data-count]');
        this.viewport.addEventListener('scroll', () => this.onScroll());
        new ResizeObserver(() => this.render()).observe(this.viewport);
        this.items = [];
        this.cursor = null;
        this.loading = false;
        this.finished = true;
        this.canvas.replaceChildren(this.message('Выберите доступную схему'));
    }

    reset() {
        this.items = [];
        this.cursor = null;
        this.loading = false;
        this.finished = false;
        this.version = requestVersion;
        this.viewport.scrollTop = 0;
        this.canvas.replaceChildren(this.message('Загрузка операций…'));
        this.count.textContent = '0';
        this.load();
    }

    async load() {
        if (this.loading || this.finished) return;
        this.loading = true;
        try {
            const params = filterParams();
            params.set('flow', this.flow);
            if (this.cursor) params.set('cursor', this.cursor);
            const response = await fetchJson(`/api/actions?${params}`);
            if (this.version !== requestVersion) return;
            this.items.push(...response.items);
            this.cursor = response.next_cursor;
            this.finished = !this.cursor;
            this.count.textContent = this.items.length.toLocaleString('ru-RU') + (this.finished ? '' : '+');
            this.render();
        } catch (error) {
            this.canvas.replaceChildren(this.message(error.message, true));
        } finally {
            this.loading = false;
        }
    }

    onScroll() {
        if (notePopover.matches(':popover-open')) notePopover.hidePopover();
        this.render();
        if (this.viewport.scrollTop + this.viewport.clientHeight >= this.canvas.offsetHeight - ROW_HEIGHT * 8) {
            this.load();
        }
    }

    render() {
        if (!this.items.length) {
            if (this.finished) this.canvas.replaceChildren(this.message('Операций не найдено'));
            return;
        }
        const start = Math.max(0, Math.floor(this.viewport.scrollTop / ROW_HEIGHT) - BUFFER);
        const visible = Math.ceil(this.viewport.clientHeight / ROW_HEIGHT) + BUFFER * 2;
        const end = Math.min(this.items.length, start + visible);
        this.canvas.style.height = `${this.items.length * ROW_HEIGHT + (this.finished ? 0 : ROW_HEIGHT * 4)}px`;
        const fragment = document.createDocumentFragment();
        for (let index = start; index < end; index++) {
            fragment.append(this.row(this.items[index], index));
        }
        if (!this.finished && end === this.items.length) fragment.append(this.message('Загрузка…', false, end));
        this.canvas.replaceChildren(fragment);
        this.enhanceNotes();
    }

    enhanceNotes() {
        for (const note of this.canvas.querySelectorAll('.operation-row__note')) {
            if (note.scrollWidth <= note.clientWidth) continue;
            note.classList.add('operation-row__note--truncated');
            note.tabIndex = 0;
            note.setAttribute('role', 'button');
            note.setAttribute('aria-label', 'Показать полное примечание');
            const open = () => showNote(note, note.fullText);
            note.addEventListener('click', open);
            note.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    open();
                }
            });
        }
    }

    row(item, index) {
        const row = document.createElement('article');
        row.className = 'operation-row' + (item.is_black ? ' operation-row--protected' : '');
        row.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
        const operation = [item.direction, item.action_type].filter(Boolean).join(' · ') || 'Без направления';
        const suboperation = item.suboperation_placeholder
            ? `Неизвестно (ID: ${item.suboperation_id})`
            : [item.suboperation_l1, item.suboperation_l2].filter(Boolean).join(' · ');
        const hasNote = Boolean(item.memo?.trim());
        if (hasNote) row.classList.add('operation-row--has-note');
        row.innerHTML = `
            <time class="operation-row__date">${formatDate(item.action_date)}</time>
            <span class="operation-row__account">${escapeHtml(item.account)}<small>${escapeHtml(item.currency)}</small></span>
            <span class="operation-row__operation">${escapeHtml(operation)}</span>
            <span class="operation-row__suboperation">
                <span class="operation-row__suboperation-text">${escapeHtml(suboperation || '—')}</span>
                ${hasNote ? `<small class="operation-row__note">${escapeHtml(item.memo)}</small>` : ''}
            </span>
            <strong class="operation-row__amount">${money.format(item.amount || 0)} <small>${escapeHtml(item.currency)}</small></strong>`;
        row.querySelector('.operation-row__account').title = item.account || '';
        row.querySelector('.operation-row__operation').title = operation;
        row.querySelector('.operation-row__suboperation').title = suboperation || '';
        if (hasNote) row.querySelector('.operation-row__note').fullText = item.memo;
        return row;
    }

    message(text, error = false, index = 0) {
        const element = document.createElement('p');
        element.className = 'operation-panel__message' + (error ? ' operation-panel__message--error' : '');
        element.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
        element.textContent = text;
        return element;
    }
}

const lists = [...document.querySelectorAll('.operation-panel')].map(panel => new VirtualList(panel));

function defaultDates() {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 29);
    return [isoDate(start), isoDate(end)];
}

function restoreFilters() {
    const params = new URLSearchParams(location.search);
    const [from, to] = defaultDates();
    form.elements.from_date.value = params.get('from_date') || from;
    form.elements.to_date.value = params.get('to_date') || to;
    form.elements.include_protected.checked = params.get('include_protected') === '1';
    for (const name of Object.keys(lookupFields)) form.elements[name].dataset.value = params.get(name) || '';
}

function filterParams() {
    const params = new URLSearchParams();
    for (const element of form.elements) {
        if (!element.name) continue;
        if (element.type === 'checkbox') {
            if (element.checked) params.set(element.name, '1');
        } else if (element.value) {
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
    requestVersion++;
    const version = requestVersion;
    updateUrl(filterParams());
    status.textContent = 'Обновление…';
    lists.forEach(list => list.reset());
    try {
        const data = await fetchJson(`/api/action-summary?${filterParams()}`);
        if (version !== requestVersion) return;
        renderSummary(data);
        status.textContent = `Найдено ${Number(data.operation_count).toLocaleString('ru-RU')} операций`;
    } catch (error) {
        status.textContent = error.message;
    }
}

function renderSummary(data) {
    document.querySelector('#summary-count').textContent = `${Number(data.operation_count).toLocaleString('ru-RU')} операций`;
    document.querySelector('#currency-summary').innerHTML = summaryTable(data.currencies, false);
    document.querySelector('#direction-summary').innerHTML = summaryTable(data.directions, true);
}

function summaryTable(rows, withDirection) {
    const heading = withDirection ? '<th>Направление</th>' : '';
    const body = rows.map(row => `<tr>
        ${withDirection ? `<td>${escapeHtml(row.direction)}</td>` : ''}
        <td>${escapeHtml(row.currency)}</td>
        <td>${money.format(row.opening)}</td>
        <td class="summary-table__value--income">${money.format(row.income)}</td>
        <td class="summary-table__value--expense">${money.format(row.expense)}</td>
        <td>${money.format(row.current)}</td>
        <td class="summary-table__value--strong">${money.format(row.closing)}</td>
    </tr>`).join('');
    return `<table class="summary-table"><thead><tr>${heading}<th>Валюта</th><th>Начальное</th><th>Приход</th><th>Расход</th><th>За период</th><th>Конечное</th></tr></thead><tbody>${body || '<tr><td colspan="7">Нет данных</td></tr>'}</tbody></table>`;
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        headers: { Accept: 'application/json', ...options.headers },
    });
    const data = await response.json();
    if (response.status === 401) {
        location.replace('/login');
        throw new Error('Требуется вход');
    }
    if (!response.ok) throw new Error(data.error || 'Ошибка загрузки');
    return data;
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

form.addEventListener('change', event => {
    const hierarchy = ['direction_id', 'action_type_id', 'suboperation_l1_id', 'suboperation_l2_id'];
    if (hierarchy.includes(event.target.name)) {
        clearDescendants(event.target.name);
        refreshCascade('action_type_id');
    }
    refresh();
});
document.querySelector('#reset').addEventListener('click', () => {
    form.reset();
    const [from, to] = defaultDates();
    form.elements.from_date.value = from;
    form.elements.to_date.value = to;
    for (const name of Object.keys(lookupFields)) form.elements[name].value = '';
    refreshCascade();
    refresh();
});

document.querySelector('#logout').addEventListener('click', async () => {
    await fetchJson('/api/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': currentUser.csrf_token },
    });
    location.replace('/login');
});

document.querySelector('#data-schema').addEventListener('change', async event => {
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
        refresh();
    } catch (error) {
        status.textContent = error.message;
    }
});

async function init() {
    try {
        currentUser = await fetchJson('/api/me');
        document.querySelector('#current-user').textContent = currentUser.login;
        const schemaSelect = document.querySelector('#data-schema');
        const unavailable = new Set(currentUser.unavailable_data_schemas);
        schemaSelect.replaceChildren(...currentUser.data_schemas.map(schema => {
            const option = new Option(unavailable.has(schema) ? `${schema} — недоступна` : schema, schema);
            option.disabled = unavailable.has(schema);
            return option;
        }));
        schemaSelect.value = currentUser.data_schema;
        const protectedField = document.querySelector('#protected-filter');
        protectedField.hidden = !currentUser.can_view_protected;
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
        refresh();
    } catch (error) {
        status.textContent = error.message;
    }
}

init();
