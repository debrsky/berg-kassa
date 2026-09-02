const rows = document.querySelector('#user-rows');
const form = document.querySelector('#user-form');
const status = document.querySelector('#status');
const message = document.querySelector('#user-message');
let csrf;
let users = [];

async function fetchJson(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { Accept: 'application/json', ...options.headers } });
    const data = await response.json();
    if (response.status === 401) location.replace('/login');
    if (!response.ok) throw new Error(data.error || 'Ошибка загрузки');
    return data;
}

function edit(user = null) {
    form.reset();
    form.elements.id.value = user?.id || '';
    form.elements.login.value = user?.login || '';
    form.elements.data_schemas.value = user?.data_schemas.join(', ') || '';
    form.elements.can_view_protected.checked = user?.can_view_protected || false;
    form.elements.is_active.checked = user?.is_active ?? true;
    form.elements.password.required = !user;
    document.querySelector('#password-hint').textContent = user ? '(оставьте пустым, чтобы не менять)' : '(обязателен для нового пользователя)';
    message.textContent = '';
}

function render() {
    rows.replaceChildren(...users.map(user => {
        const row = document.createElement('tr');
        for (const value of [user.login, user.data_schemas.join(', '), user.can_view_protected ? 'Да' : 'Нет', user.is_active ? 'Да' : 'Нет']) {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.append(cell);
        }
        const action = document.createElement('td');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Изменить';
        button.addEventListener('click', () => edit(user));
        action.append(button);
        row.append(action);
        return row;
    }));
}

async function load() {
    const data = await fetchJson('/api/users');
    users = data.items;
    render();
    status.textContent = `Пользователей: ${users.length}`;
}

form.addEventListener('submit', async event => {
    event.preventDefault();
    const id = form.elements.id.value;
    const data = {
        login: form.elements.login.value,
        data_schemas: form.elements.data_schemas.value.split(',').map(value => value.trim()).filter(Boolean),
        password: form.elements.password.value,
        can_view_protected: form.elements.can_view_protected.checked,
        is_active: form.elements.is_active.checked,
    };
    message.textContent = 'Сохранение…';
    try {
        const saved = await fetchJson(id ? `/api/users/${id}` : '/api/users', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify(data),
        });
        await load();
        edit(users.find(user => user.id === saved.id));
        message.textContent = 'Сохранено';
    } catch (error) {
        message.textContent = error.message;
    }
});

document.querySelector('#new-user').addEventListener('click', () => edit());
document.querySelector('#logout').addEventListener('click', async () => {
    await fetchJson('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': csrf } });
    location.replace('/login');
});

(async () => {
    try {
        const user = await fetchJson('/api/me');
        csrf = user.csrf_token;
        document.querySelector('#current-user').textContent = user.login;
        edit();
        await load();
    } catch (error) {
        status.textContent = error.message;
    }
})();
