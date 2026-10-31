const rows = document.querySelector('#user-rows');
const form = document.querySelector('#user-form');
const status = document.querySelector('#status');
const message = document.querySelector('#user-message');
let csrf;
let users = [];
let currentUser;

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
        const editButton = document.createElement('button');
        editButton.type = 'button';
        editButton.textContent = 'Изменить';
        editButton.addEventListener('click', () => edit(user));
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.textContent = 'Удалить';
        deleteButton.disabled = user.id === currentUser.id;
        deleteButton.addEventListener('click', async () => {
            if (!confirm(`Удалить пользователя «${user.login}»?`)) return;
            let deleted = false;
            try {
                await fetchJson(`/api/users/${user.id}`, { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } });
                deleted = true;
                message.textContent = 'Удалено. Обновление списка…';
                await load();
                message.textContent = 'Удалено';
            } catch (error) {
                message.textContent = deleted ? `Удалено, но список не обновился. ${error.message}` : error.message;
            }
        });
        action.append(editButton, deleteButton);
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
    const submit = form.querySelector('[type=submit]');
    if (submit.disabled) return;
    submit.disabled = true;
    const id = form.elements.id.value;
    const data = {
        login: form.elements.login.value,
        data_schemas: form.elements.data_schemas.value.split(',').map(value => value.trim()).filter(Boolean),
        password: form.elements.password.value,
        can_view_protected: form.elements.can_view_protected.checked,
        is_active: form.elements.is_active.checked,
    };
    message.textContent = 'Сохранение…';
    let saved = false;
    try {
        const result = await fetchJson(id ? `/api/users/${id}` : '/api/users', {
            method: id ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify(data),
        });
        saved = true;
        edit({ ...data, id: result.id });
        message.textContent = 'Сохранено. Обновление списка…';
        await load();
        edit(users.find(user => user.id === result.id));
        message.textContent = 'Сохранено';
    } catch (error) {
        message.textContent = saved ? `Сохранено, но список не обновился. ${error.message}` : error.message;
    } finally {
        submit.disabled = false;
    }
});

document.querySelector('#new-user').addEventListener('click', () => edit());
bindLogout(() => csrf);

document.querySelector('#operation-settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    const settingsForm = event.currentTarget;
    const button = settingsForm.querySelector('[type=submit]');
    if (button.disabled) return;
    button.disabled = true;
    const message = document.querySelector('#operation-settings-message');
    try {
        await fetchJson('/api/operation-settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify({ edit_days: Number(settingsForm.elements.edit_days.value) }),
        });
        message.textContent = 'Период сохранён';
    } catch (error) {
        message.textContent = error.message;
    } finally {
        button.disabled = false;
    }
});

(async () => {
    try {
        currentUser = await fetchJson('/api/me');
        csrf = currentUser.csrf_token;
        document.querySelector('#current-user').textContent = currentUser.login;
        const settings = await fetchJson('/api/operation-settings');
        const settingsForm = document.querySelector('#operation-settings-form');
        settingsForm.elements.edit_days.value = settings.edit_days;
        document.querySelector('#operation-settings-timezone').textContent = 'Часовой пояс сервера: ' + settings.server_timezone;
        settingsForm.querySelector('[type=submit]').disabled = false;
        edit();
        await load();
    } catch (error) {
        status.textContent = error.message;
    }
})();
