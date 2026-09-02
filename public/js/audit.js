const form = document.querySelector('#audit-filter');
const rows = document.querySelector('#audit-rows');
const status = document.querySelector('#status');
const pageInfo = document.querySelector('#audit-page-info');
const previous = document.querySelector('#audit-prev');
const next = document.querySelector('#audit-next');
const limit = 50;
let offset = 0;
let total = 0;
let csrf;

async function fetchJson(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
    const data = await response.json();
    if (response.status === 401) location.replace('/login');
    if (!response.ok) throw new Error(data.error || 'Ошибка загрузки');
    return data;
}

function cell(value) {
    const element = document.createElement('td');
    element.textContent = value ?? '—';
    return element;
}

function render(items) {
    rows.replaceChildren(...items.map(item => {
        const row = document.createElement('tr');
        row.append(
            cell(new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(item.created_at))),
            cell(item.event),
            cell(item.login || (item.user_id ? `ID: ${item.user_id}` : null)),
            cell(item.ip),
            cell(item.data_schema),
            cell(item.entity ? `${item.entity}${item.entity_id ? ` #${item.entity_id}` : ''}` : null),
        );
        const detailsCell = document.createElement('td');
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        const content = document.createElement('pre');
        summary.textContent = 'Открыть';
        content.textContent = JSON.stringify(item.details, null, 2);
        details.append(summary, content);
        detailsCell.append(details);
        row.append(detailsCell);
        return row;
    }));
    if (!items.length) {
        const row = document.createElement('tr');
        const empty = cell('События не найдены');
        empty.colSpan = 7;
        row.append(empty);
        rows.append(row);
    }
}

async function load() {
    status.textContent = 'Загрузка…';
    const params = new URLSearchParams(new FormData(form));
    for (const [name, value] of [...params]) if (!value) params.delete(name);
    params.set('offset', offset);
    params.set('limit', limit);
    try {
        const data = await fetchJson(`/api/audit-log?${params}`);
        total = data.total;
        const event = form.elements.event.value;
        form.elements.event.replaceChildren(new Option('Все события', ''), ...data.events.map(value => new Option(value, value)));
        form.elements.event.value = event;
        render(data.items);
        const first = total ? offset + 1 : 0;
        pageInfo.textContent = `${first}–${Math.min(offset + limit, total)} из ${total}`;
        previous.disabled = offset === 0;
        next.disabled = offset + limit >= total;
        status.textContent = `Событий: ${total}`;
    } catch (error) {
        status.textContent = error.message;
    }
}

form.addEventListener('submit', event => {
    event.preventDefault();
    offset = 0;
    load();
});
document.querySelector('#audit-reset').addEventListener('click', () => {
    form.reset();
    offset = 0;
    load();
});
previous.addEventListener('click', () => { offset = Math.max(0, offset - limit); load(); });
next.addEventListener('click', () => { offset += limit; load(); });
document.querySelector('#logout').addEventListener('click', async () => {
    await fetchJson('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
    location.replace('/login');
});

(async () => {
    try {
        const user = await fetchJson('/api/me');
        csrf = user.csrf_token;
        document.querySelector('#current-user').textContent = user.login;
        await load();
    } catch (error) {
        status.textContent = error.message;
    }
})();
