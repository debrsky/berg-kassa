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
    for (const row of [...data.currencies, ...data.directions]) {
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
            is_debit: true, is_black: false, memo: `E2E ${Date.now()}`,
        };
        let response = await request.post('/api/actions', {
            headers: { 'X-CSRF-Token': csrf },
            data: { ...body, posting: { account_id: account.id, suboperation_id: suboperation.id } },
        });
        expect(response.status()).toBe(201);
        ({ id, posting_id: postingId } = await response.json());
        expect(postingId).toBeTruthy();
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
    expect((await (await request.get('/api/me')).json()).can_view_protected).toBe(false);
    expect((await request.get('/api/audit-log')).status()).toBe(403);
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
        const sub2 = await create('suboperations_l2', { suboperation_l1_id: sub1, name: marker, memo: '' });
        const response = await request.put(`/api/references/suboperations_l2/${sub2}`, {
            headers: { 'X-CSRF-Token': csrf }, data: { suboperation_l1_id: sub1, name: `${marker} edited`, memo: '' },
        });
        expect(response.ok()).toBeTruthy();
    } finally {
        for (const [type, id] of created.reverse()) {
            expect((await request.delete(`/api/references/${type}/${id}`, { headers: { 'X-CSRF-Token': csrf } })).ok()).toBeTruthy();
        }
    }
});
