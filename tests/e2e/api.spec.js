const { test, expect } = require('@playwright/test');

const login = process.env.E2E_USER;
const password = process.env.E2E_PASSWORD;
const restrictedLogin = process.env.E2E_RESTRICTED_USER;
const restrictedPassword = process.env.E2E_RESTRICTED_PASSWORD;
let csrf;

test.beforeEach(async ({ request }) => {
    test.skip(!login || !password, 'Задайте E2E_USER и E2E_PASSWORD');
    const response = await request.post('/api/login', { data: { login, password } });
    expect(response.ok()).toBeTruthy();
    csrf = (await (await request.get('/api/me')).json()).csrf_token;
});

test('справочники имеют ожидаемую структуру', async ({ request }) => {
    const response = await request.get('/api/lookups');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    for (const name of ['accounts', 'currencies', 'directions', 'action_types', 'suboperations_l1', 'suboperations_l2']) {
        expect(Array.isArray(data[name]), name).toBeTruthy();
    }
    expect(data.currencies.every(currency => 'default_rate' in currency)).toBeTruthy();
});

test('список операций валидирует поток и размер страницы', async ({ request }) => {
    expect((await request.get('/api/actions?flow=wrong')).status()).toBe(400);
    expect((await request.get('/api/actions?flow=income&limit=201')).status()).toBe(400);
    const response = await request.get('/api/actions?flow=income&offset=0&limit=5&include_total=1');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.items.length).toBeLessThanOrEqual(5);
    expect(Number.isInteger(data.total)).toBeTruthy();
    for (let index = 1; index < data.items.length; index++) {
        expect(new Date(data.items[index - 1].action_date).getTime()).toBeGreaterThanOrEqual(new Date(data.items[index].action_date).getTime());
    }
});

test('итоги удовлетворяют формулам баланса', async ({ request }) => {
    const response = await request.get('/api/action-summary?from_date=2020-01-01&to_date=2099-12-31');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(data.operation_count).toBe(data.currencies.reduce((sum, row) => sum + Number(row.operation_count), 0));
    expect(data).not.toHaveProperty('directions');
    for (const row of data.currencies) {
        expect(Number(row.current)).toBeCloseTo(Number(row.income) - Number(row.expense), 2);
        expect(Number(row.closing)).toBeCloseTo(Number(row.opening) + Number(row.current), 2);
    }
});

test('изменяющие запросы требуют CSRF', async ({ request }) => {
    const response = await request.post('/api/references/currencies', { data: { name: 'csrf-test' } });
    expect(response.status()).toBe(403);
});

test('поля операции и параметры фильтров валидируются', async ({ request }) => {
    const invalidAction = await request.post('/api/actions', {
        headers: { 'X-CSRF-Token': csrf },
        data: { account_id: 0, currency_id: 0, suboperation_id: 0, action_date: 'bad', amount: -1 },
    });
    expect(invalidAction.status()).toBe(400);
    expect((await request.get('/api/actions?flow=income&account_id=1%20OR%201=1')).status()).toBe(400);
    expect((await request.get('/api/action-summary?from_date=not-a-date&to_date=2026-12-31')).status()).toBe(400);
});

test('неизвестный справочник отклоняется', async ({ request }) => {
    expect((await request.get('/api/references/not_a_table')).status()).toBe(400);
});

test('CRUD валюты создаёт, изменяет и удаляет запись', async ({ request }) => {
    const marker = `E2E ${Date.now()}`;
    let id;
    try {
        let response = await request.post('/api/references/currencies', {
            headers: { 'X-CSRF-Token': csrf }, data: { name: marker, memo: 'created' },
        });
        expect(response.status()).toBe(201);
        id = (await response.json()).id;
        response = await request.put(`/api/references/currencies/${id}`, {
            headers: { 'X-CSRF-Token': csrf }, data: { name: `${marker} edited`, memo: 'updated' },
        });
        expect(response.ok()).toBeTruthy();
        const records = await (await request.get('/api/references/currencies')).json();
        expect(records.find(item => item.id === id)?.name).toBe(`${marker} edited`);
    } finally {
        if (id) expect((await request.delete(`/api/references/currencies/${id}`, { headers: { 'X-CSRF-Token': csrf } })).ok()).toBeTruthy();
    }
});

test('CRUD операции очищает созданные данные', async ({ request }) => {
    const lookups = await (await request.get('/api/lookups')).json();
    const account = lookups.accounts[0];
    const currency = lookups.currencies.find(item => String(item.id) === String(account.currency_id)) || lookups.currencies[0];
    const suboperation = lookups.suboperations_l2.find(item => !item.is_placeholder) || lookups.suboperations_l2[0];
    test.skip(!account || !currency || !suboperation, 'Недостаточно справочных данных');
    let id;
    let postingId;
    try {
        const body = {
            account_id: account.id, currency_id: currency.id, suboperation_id: suboperation.id,
            action_date: '2026-01-15T12:00', amount: '123.45', exchange_rate: '1',
            is_debit: true, is_black: false, memo: `E2E ${Date.now()} Аренда 50%_!`,
        };
        let response = await request.post('/api/actions', {
            headers: { 'X-CSRF-Token': csrf },
            data: { ...body, posting: { account_id: account.id, suboperation_id: suboperation.id } },
        });
        expect(response.status()).toBe(201);
        ({ id, posting_id: postingId } = await response.json());
        expect(postingId).toBeTruthy();
        const query = new URLSearchParams({ from_date: '', to_date: '', memo: body.memo.toLowerCase(), account_id: String(account.id) });
        for (const [flow, expectedId] of [['income', id], ['expense', postingId]]) {
            const result = await request.get(`/api/actions?${query}&flow=${flow}&include_total=1`);
            expect(result.ok()).toBeTruthy();
            const data = await result.json();
            expect(data.total).toBe(1);
            expect(data.items[0].id).toBe(expectedId);
        }
        const summary = await (await request.get(`/api/action-summary?${query}`)).json();
        expect(summary.operation_count).toBe(2);
        expect(Number(summary.currencies[0].income)).toBe(123.45);
        expect(Number(summary.currencies[0].expense)).toBe(123.45);
        query.set('memo', body.memo.replace('50%_!', '50__!'));
        expect((await (await request.get(`/api/action-summary?${query}`)).json()).operation_count).toBe(0);

        const expenses = await (await request.get(`/api/actions?flow=expense&from_date=2026-01-15&to_date=2026-01-15&account_id=${account.id}&limit=200`)).json();
        expect(expenses.items.some(item => item.id === postingId)).toBeTruthy();
        response = await request.put(`/api/actions/${id}`, {
            headers: { 'X-CSRF-Token': csrf }, data: { ...body, amount: '234.56', memo: `${body.memo} edited` },
        });
        expect(response.ok()).toBeTruthy();
    } finally {
        if (id) expect((await request.delete(`/api/actions/${id}`, { headers: { 'X-CSRF-Token': csrf } })).ok()).toBeTruthy();
        if (postingId) expect((await request.delete(`/api/actions/${postingId}`, { headers: { 'X-CSRF-Token': csrf } })).ok()).toBeTruthy();
    }
});

test('ошибка проводки не сохраняет основную операцию', async ({ request }) => {
    const lookups = await (await request.get('/api/lookups')).json();
    const account = lookups.accounts[0];
    const currency = lookups.currencies[0];
    const suboperation = lookups.suboperations_l2[0];
    test.skip(!account || !currency || !suboperation, 'Недостаточно справочных данных');
    const summaryUrl = '/api/action-summary?from_date=2040-01-15&to_date=2040-01-15';
    const before = (await (await request.get(summaryUrl)).json()).operation_count;
    const response = await request.post('/api/actions', {
        headers: { 'X-CSRF-Token': csrf },
        data: {
            account_id: account.id, currency_id: currency.id, suboperation_id: suboperation.id,
            action_date: '2040-01-15T12:00', amount: '123.45', exchange_rate: '1',
            is_debit: true, is_black: false,
            posting: { account_id: '2147483647', suboperation_id: suboperation.id },
        },
    });
    expect(response.status()).toBe(400);
    expect((await (await request.get(summaryUrl)).json()).operation_count).toBe(before);
});

test('явная проверка блокирует удаление используемого счёта', async ({ request }) => {
    const actions = await (await request.get('/api/actions?flow=income&limit=1')).json();
    test.skip(!actions.items.length, 'Нет операций для проверки зависимости');
    const response = await request.delete(`/api/references/accounts/${actions.items[0].account_id}`, { headers: { 'X-CSRF-Token': csrf } });
    expect(response.status()).toBe(409);
    expect((await response.json()).error).toContain('используется');
});

test('критические чтения укладываются в две секунды и работают параллельно', async ({ request }) => {
    const started = Date.now();
    const responses = await Promise.all([
        request.get('/api/lookups'),
        request.get('/api/actions?flow=income&limit=100'),
        request.get('/api/actions?flow=expense&limit=100'),
        request.get('/api/action-summary?from_date=2026-01-01&to_date=2026-12-31'),
    ]);
    expect(responses.every(response => response.ok())).toBeTruthy();
    if (!process.env.E2E_LOAD) expect(Date.now() - started).toBeLessThan(2000);
});

test('авторизация, методы и права на схему защищены', async ({ request }) => {
    expect((await request.post('/api/login', { data: { login, password: `${password}-wrong` } })).status()).toBe(401);
    expect((await request.get('/api/logout')).status()).toBe(405);
    expect((await request.put('/api/references/currencies')).status()).toBe(405);
    expect((await request.get('/api/does-not-exist')).status()).toBe(404);
    expect((await request.post('/api/schema', {
        headers: { 'X-CSRF-Token': csrf }, data: { schema: 'definitely_not_allowed' },
    })).status()).toBe(403);
});

test('API отвечает JSON', async ({ request }) => {
    const api = await request.get('/api/me');
    expect(api.headers()['content-type']).toContain('application/json');
});

test('журнал аудита доступен только с правом защищённых операций', async ({ request }) => {
    const me = await (await request.get('/api/me')).json();
    const response = await request.get('/api/audit-log?limit=5');
    if (!me.can_view_protected) {
        expect(response.status()).toBe(403);
        return;
    }
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(Array.isArray(data.items)).toBeTruthy();
    expect(Array.isArray(data.events)).toBeTruthy();
    expect(data.items.length).toBeLessThanOrEqual(5);
    expect(Number.isInteger(data.total)).toBeTruthy();
    expect((await request.get('/api/audit-log?limit=101')).status()).toBe(400);
    expect((await request.get('/api/audit-log?event=bad%20event')).status()).toBe(400);
    if (data.events.length) {
        const filtered = await (await request.get(`/api/audit-log?event=${encodeURIComponent(data.events[0])}&from_date=2020-01-01&to_date=2099-12-31&limit=5`)).json();
        expect(filtered.items.every(item => item.event === data.events[0])).toBeTruthy();
    }
});

test('пользователь без права защищённых операций не получает журнал аудита', async ({ request }) => {
    test.skip(!restrictedLogin || !restrictedPassword, 'Задайте E2E_RESTRICTED_USER и E2E_RESTRICTED_PASSWORD');
    expect((await request.post('/api/login', { data: { login: restrictedLogin, password: restrictedPassword } })).ok()).toBeTruthy();
    const restrictedUser = await (await request.get('/api/me')).json();
    expect(restrictedUser.can_view_protected).toBe(false);
    expect((await request.get('/audit')).status()).toBe(403);
    for (const type of ['accounts', 'currencies', 'currency_rates', 'directions', 'action_types', 'suboperations_l1', 'suboperations_l2']) {
        expect((await request.get(`/api/references/${type}`)).ok()).toBeTruthy();
        for (const method of ['POST', 'PUT', 'DELETE']) {
            const response = await request.fetch(`/api/references/${type}${method === 'POST' ? '' : '/2147483647'}`, {
                method,
                headers: { 'X-CSRF-Token': restrictedUser.csrf_token },
                data: {},
            });
            expect(response.status(), `${method} ${type}`).toBe(403);
        }
    }
    expect((await request.get('/api/audit-log')).status()).toBe(403);
    expect((await request.get('/api/users')).status()).toBe(403);
});

test('управление пользователями доступно только администратору', async ({ request }) => {
    const me = await (await request.get('/api/me')).json();
    const response = await request.get('/api/users');
    if (!me.can_view_protected) {
        expect(response.status()).toBe(403);
        return;
    }
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(Array.isArray(data.items)).toBeTruthy();
    expect(data.items.every(item => !('password_hash' in item))).toBeTruthy();
});

test('администратор создаёт и удаляет пользователя, логин не зависит от регистра', async ({ request }) => {
    const me = await (await request.get('/api/me')).json();
    test.skip(!me.can_view_protected, 'Требуется администратор');
    const login = `e2e-delete-${Date.now()}`;
    const body = {
        login,
        data_schemas: [me.data_schema],
        password: 'e2e-delete-password',
        can_view_protected: false,
        is_active: true,
    };
    const created = await request.post('/api/users', { headers: { 'X-CSRF-Token': csrf }, data: body });
    expect(created.status()).toBe(201);
    const id = (await created.json()).id;
    try {
        const duplicate = await request.post('/api/users', {
            headers: { 'X-CSRF-Token': csrf }, data: { ...body, login: login.toUpperCase() },
        });
        expect(duplicate.status()).toBe(409);
        expect((await request.delete(`/api/users/${me.id}`, { headers: { 'X-CSRF-Token': csrf } })).status()).toBe(400);
    } finally {
        expect((await request.delete(`/api/users/${id}`, { headers: { 'X-CSRF-Token': csrf } })).ok()).toBeTruthy();
    }
});

test('CRUD дерева операций очищает созданные записи', async ({ request }) => {
    const marker = `E2E tree ${Date.now()}`;
    const created = [];
    const create = async (type, data) => {
        const response = await request.post(`/api/references/${type}`, { headers: { 'X-CSRF-Token': csrf }, data });
        expect(response.status()).toBe(201);
        const id = (await response.json()).id;
        created.push([type, id]);
        return id;
    };
    try {
        const direction = await create('directions', { name: marker, memo: '' });
        const action = await create('action_types', { direction_id: direction, name: marker, memo: '' });
        const sub1 = await create('suboperations_l1', { action_type_id: action, name: marker, memo: '' });
        const sub2 = await create('suboperations_l2', { suboperation_l1_id: sub1, name: marker, memo: 'created memo' });
        const response = await request.put(`/api/references/suboperations_l2/${sub2}`, {
            headers: { 'X-CSRF-Token': csrf }, data: { suboperation_l1_id: sub1, name: `${marker} edited`, memo: 'updated memo' },
        });
        expect(response.ok()).toBeTruthy();
        const lookups = await (await request.get('/api/lookups')).json();
        expect(lookups.suboperations_l2.find(item => item.id === sub2)?.memo).toBe('updated memo');
    } finally {
        for (const [type, id] of created.reverse()) {
            expect((await request.delete(`/api/references/${type}/${id}`, { headers: { 'X-CSRF-Token': csrf } })).ok()).toBeTruthy();
        }
    }
});

test('за всё время учитывает все операции без начального сальдо', async ({ request }) => {
    const response = await request.get('/api/action-summary?from_date=&to_date=');
    expect(response.ok()).toBeTruthy();
    const summary = await response.json();
    let count = 0;
    for (const flow of ['income', 'expense']) {
        const actions = await request.get(`/api/actions?from_date=&to_date=&flow=${flow}&include_total=1&limit=1`);
        expect(actions.ok()).toBeTruthy();
        count += (await actions.json()).total;
    }
    expect(summary.operation_count).toBe(count);
    for (const row of summary.currencies) {
        expect(Number(row.opening)).toBe(0);
        expect(Number(row.closing)).toBeCloseTo(Number(row.income) - Number(row.expense), 2);
    }
});

test('пустая граница периода не ограничивает операции с этой стороны', async ({ request }) => {
    for (const query of ['from_date=&to_date=2024-03-01', 'from_date=2024-03-01&to_date=', 'from_date=&to_date=']) {
        const response = await request.get(`/api/action-summary?${query}`);
        expect(response.ok()).toBeTruthy();
        const summary = await response.json();
        let count = 0;
        for (const flow of ['income', 'expense']) {
            const response = await request.get(`/api/actions?${query}&flow=${flow}&include_total=1&limit=5`);
            expect(response.ok()).toBeTruthy();
            const actions = await response.json();
            count += actions.total;
            for (const row of actions.items) {
                if (query.startsWith('from_date=2024')) expect(row.action_date.slice(0, 10) >= '2024-03-01').toBeTruthy();
                if (query.endsWith('to_date=2024-03-01')) expect(row.action_date.slice(0, 10) <= '2024-03-01').toBeTruthy();
            }
        }
        expect(summary.operation_count).toBe(count);
        if (query.startsWith('from_date=&')) {
            for (const row of summary.currencies) expect(Number(row.opening)).toBe(0);
        }
    }
});

test('поиск по примечанию валидирует параметр', async ({ request }) => {
    for (const query of ['memo[]=x', `memo=${'x'.repeat(2001)}`]) {
        expect((await request.get(`/api/actions?flow=income&${query}`)).status()).toBe(400);
        expect((await request.get(`/api/action-summary?${query}`)).status()).toBe(400);
    }
});

test('отметка операции переключается и фильтруется', async ({ request }) => {
    const me = await (await request.get('/api/me')).json();
    const field = me.can_view_protected ? 'is_checked_superuser' : 'is_checked_user';
    const filter = me.can_view_protected ? 'checked_superuser' : 'checked_user';
    const page = await (await request.get('/api/actions?flow=income&from_date=&to_date=&limit=1')).json();
    test.skip(!page.items.length, 'Нет операции для проверки');
    const item = page.items[0];
    const original = item[field];
    try {
        const response = await request.patch(`/api/actions/${item.id}/check`, {
            headers: { 'X-CSRF-Token': csrf }, data: { checked: !original },
        });
        expect(response.ok()).toBeTruthy();
        expect((await response.json())[field]).toBe(!original);
        const filtered = await (await request.get(`/api/actions?flow=income&from_date=&to_date=&income_${filter}=${original ? 0 : 1}&limit=200`)).json();
        expect(filtered.items.some(action => action.id === item.id)).toBeTruthy();
        expect((await request.get(`/api/action-summary?from_date=&to_date=&income_${filter}=${original ? 0 : 1}`)).ok()).toBeTruthy();
    } finally {
        await request.patch(`/api/actions/${item.id}/check`, {
            headers: { 'X-CSRF-Token': csrf }, data: { checked: original },
        });
    }
});

test('большие суммы сохраняются и сальдо вычисляется точно', async ({ request }) => {
    const lookups = await (await request.get('/api/lookups')).json();
    const ids = [];
    const memo = `precision-${Date.now()}`;
    const body = {
        account_id: lookups.accounts[0].id, currency_id: lookups.currencies[0].id,
        suboperation_id: lookups.suboperations_l2[0].id, action_date: '2026-01-15T12:00',
        is_black: false, memo,
    };
    try {
        for (const [is_debit, amount] of [[true, '99999999999999999.99'], [false, '99999999999999999.98']]) {
            const response = await request.post('/api/actions', { headers: { 'X-CSRF-Token': csrf }, data: { ...body, is_debit, amount } });
            expect(response.status()).toBe(201);
            ids.push((await response.json()).id);
        }
        const params = new URLSearchParams({ memo, from_date: '', to_date: '' });
        const summary = await (await request.get(`/api/action-summary?${params}`)).json();
        expect(summary.currencies[0].income).toBe('99999999999999999.99');
        expect(summary.currencies[0].current).toBe('0.01');
        expect(summary.currencies[0].closing).toBe('0.01');
        const actions = await (await request.get(`/api/actions?${params}&flow=income`)).json();
        expect(actions.items[0].amount).toBe('99999999999999999.99');
    } finally {
        for (const id of ids) expect((await request.delete(`/api/actions/${id}`, { headers: { 'X-CSRF-Token': csrf } })).ok()).toBeTruthy();
    }
});

for (const method of ['PUT', 'DELETE']) {
    test(`${method}: изменение защиты конкурентным запросом учитывается до записи`, async ({ request, playwright, baseURL }) => {
        test.skip(Boolean(process.env.E2E_BASE_URL), 'Проверка блокировок использует локальную БД');
        test.skip(!restrictedLogin || !restrictedPassword, 'Нет ограниченного пользователя');
        const { spawn } = require('node:child_process');
        const { once } = require('node:events');
        const restricted = await playwright.request.newContext({ baseURL });
        let child, finished, pending, id;
        try {
            expect((await restricted.post('/api/login', { data: { login: restrictedLogin, password: restrictedPassword } })).ok()).toBeTruthy();
            const limited = await (await restricted.get('/api/me')).json();
            expect(limited.can_view_protected).toBe(false);
            expect((await request.post('/api/schema', {
                headers: { 'X-CSRF-Token': csrf }, data: { data_schema: limited.data_schema },
            })).ok()).toBeTruthy();
            const lookups = await (await request.get('/api/lookups')).json();
            const body = {
                account_id: lookups.accounts[0].id, currency_id: lookups.currencies[0].id,
                suboperation_id: lookups.suboperations_l2[0].id, action_date: '2026-01-15T12:00',
                amount: '1.00', is_debit: true, is_black: false, memo: `lock-test-${Date.now()}`,
            };
            const created = await request.post('/api/actions', { headers: { 'X-CSRF-Token': csrf }, data: body });
            expect(created.status()).toBe(201);
            id = (await created.json()).id;
            child = spawn('.tools/php/php.exe', ['tests/integration/hold-action.php', limited.data_schema, String(id)], { windowsHide: true });
            finished = once(child, 'close');
            let output = '', errors = '';
            child.stdout.on('data', chunk => output += chunk);
            child.stderr.on('data', chunk => errors += chunk);
            await expect.poll(() => output, { timeout: 12_000 }).toContain('READY');
            pending = restricted.fetch(`/api/actions/${id}`, {
                method, headers: { 'X-CSRF-Token': limited.csrf_token }, data: body,
            });
            child.stdin.write('wait\n');
            await expect.poll(() => output, { timeout: 12_000 }).toContain('BLOCKED');
            child.stdin.end('commit\n');
            expect((await finished)[0], errors).toBe(0);
            expect((await pending).status()).toBe(method === 'PUT' ? 403 : 404);
            const result = await (await request.get(`/api/actions?from_date=&to_date=&include_protected=1&flow=income&memo=${body.memo}`)).json();
            expect(result.items).toHaveLength(1);
            expect(result.items[0].is_black).toBe(true);
        } finally {
            if (child && child.exitCode === null) { child.kill(); await finished; }
            if (pending) await pending.catch(() => {});
            if (id) expect([200, 404]).toContain((await request.delete(`/api/actions/${id}`, { headers: { 'X-CSRF-Token': csrf } })).status());
            await restricted.dispose();
        }
    });
}
