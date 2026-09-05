const connectionRequest = (() => {
    const banners = [document.querySelector('.connection-warning')];
    document.querySelectorAll('dialog').forEach(dialog => {
        const banner = banners[0].cloneNode(true);
        dialog.prepend(banner);
        banners.push(banner);
    });
    const slow = new Set();
    let offline = !navigator.onLine;
    let failure = '';

    function render() {
        const text = offline ? 'Нет подключения к сети.' : slow.size
            ? 'Ответ задерживается. Возможны проблемы с соединением или сервером. Дождитесь результата; не отправляйте изменения повторно.'
            : failure;
        banners.forEach(banner => {
            banner.hidden = !text;
            banner.textContent = text;
        });
    }

    window.addEventListener('offline', () => { offline = true; render(); });
    window.addEventListener('online', () => {
        offline = false;
        failure = 'Сеть появилась. Связь с сервером пока не подтверждена.';
        render();
    });
    render();

    return async (url, options = {}) => {
        const request = {};
        const timer = setTimeout(() => { slow.add(request); render(); }, 10_000);
        const writing = /^(POST|PUT|PATCH|DELETE)$/i.test(options.method || 'GET')
            && /^\/api\/(actions|references|users)(\/|$|\?)/.test(url);
        try {
            const response = await fetch(url, options);
            const data = await response.json();
            offline = false;
            failure = '';
            return { response, data };
        } catch (error) {
            if (error.name === 'AbortError') throw error;
            failure = writing
                ? 'Подтверждение изменения не получено. Действие могло выполниться. Проверьте список перед повторной отправкой.'
                : 'Не удалось получить ответ сервера. Возможны проблемы с соединением или сервером.';
            throw new Error(failure, { cause: error });
        } finally {
            clearTimeout(timer);
            slow.delete(request);
            render();
        }
    };
})();

async function fetchJson(url, options = {}) {
    const { response, data } = await connectionRequest(url, {
        ...options, headers: { Accept: 'application/json', ...options.headers },
    });
    if (response.status === 401) {
        location.replace('/login');
        throw new Error('Требуется вход');
    }
    if (!response.ok) throw new Error(data.error || 'Ошибка загрузки');
    return data;
}

function saveDataSchema(user, schema) {
    localStorage.setItem(`data-schema:${user.id}`, schema);
}

async function restoreDataSchema(user) {
    const key = `data-schema:${user.id}`;
    const schema = localStorage.getItem(key);
    if (!schema || !user.data_schemas.includes(schema) || user.unavailable_data_schemas.includes(schema)) {
        if (schema) localStorage.removeItem(key);
        return;
    }
    if (schema !== user.data_schema) {
        await fetchJson('/api/schema', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': user.csrf_token },
            body: JSON.stringify({ data_schema: schema }),
        });
        user.data_schema = schema;
    }
}

function bindLogout(token) {
    document.querySelector('#logout').addEventListener('click', async () => {
        try {
            await fetchJson('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': token() } });
            location.replace('/login');
        } catch (error) {
            document.querySelector('#status').textContent = 'Не удалось выйти. Повторите попытку.';
        }
    });
}
