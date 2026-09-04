const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
    test.skip(!process.env.E2E_USER || !process.env.E2E_PASSWORD, 'Нет тестового пользователя');
    expect((await page.request.post('/api/login', { data: {
        login: process.env.E2E_USER, password: process.env.E2E_PASSWORD,
    } })).ok()).toBeTruthy();
});

for (const kind of ['users', 'references']) {
    test(`${kind}: подтверждённая запись не создаётся повторно после сбоя чтения`, async ({ page }) => {
        await page.goto('/' + kind);
        await expect(page.locator('#status')).toContainText(/Схема|Пользователей/);
        const form = page.locator(kind === 'users' ? '#user-form' : '#reference-form');
        if (kind === 'users') {
            await page.locator('#new-user').click();
            await form.locator('[name=login]').fill('no-write-test');
            await form.locator('[name=data_schemas]').fill('vl');
            await form.locator('[name=password]').fill('test-password-no-write');
        } else {
            await page.locator('#reference-type').selectOption('currencies');
            await expect(page.locator('#reference-message')).not.toHaveText('Загрузка…');
            await page.locator('#new-reference').click();
            await form.locator('[name=name]').fill('no-write-test');
        }
        const methods = [];
        await page.route(kind === 'users' ? '**/api/users**' : '**/api/references/currencies**', route => {
            const method = route.request().method();
            if (method === 'GET') return route.fulfill({ status: 503, json: { error: 'Чтение недоступно' } });
            methods.push(method);
            return route.fulfill({ json: { id: 999999 } });
        });
        await form.locator('[type=submit]').click();
        await expect(form.getByRole('status')).toContainText('Сохранено, но список не обновился');
        await expect(form.locator('[name=id]')).toHaveValue('999999');
        await form.locator('[type=submit]').click();
        await expect.poll(() => methods.length).toBe(2);
        expect(methods).toEqual(['POST', 'PUT']);
    });
}

test('устаревшая ошибка итогов не заменяет новый статус', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#status')).toContainText('Найдено');
    let release;
    const gate = new Promise(resolve => release = resolve);
    let started = false;
    await page.route('**/api/action-summary?**', async route => {
        if (new URL(route.request().url()).searchParams.get('memo') === 'old') {
            started = true;
            await gate;
            return route.fulfill({ status: 500, json: { error: 'Старая ошибка' } });
        }
        return route.fulfill({ json: { currencies: [], operation_count: 42 } });
    });
    const memo = page.locator('#filters [name=memo]');
    await memo.fill('old');
    await memo.press('Enter');
    await expect.poll(() => started).toBe(true);
    await memo.fill('new');
    await memo.press('Enter');
    await expect(page.locator('#status')).toHaveText('Найдено 42 операций');
    const response = page.waitForResponse(r => r.url().includes('/api/action-summary?') && r.url().includes('memo=old'));
    release();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.locator('#status')).toHaveText('Найдено 42 операций');
});

test('справочники остаются заблокированы после сбоя смены схемы', async ({ page }) => {
    await page.route('**/api/me', async route => {
        const response = await route.fetch();
        const user = await response.json();
        await route.fulfill({ json: { ...user, data_schemas: [user.data_schema, 'test_other'], unavailable_data_schemas: [] } });
    });
    await page.goto('/references');
    await expect(page.locator('#status')).toContainText('Схема');
    await page.route('**/api/schema', route => route.fulfill({ json: { ok: true } }));
    await page.route('**/api/lookups', route => route.fulfill({ status: 503, json: { error: 'Чтение недоступно' } }));
    await page.locator('#data-schema').selectOption('test_other');
    await expect(page.locator('#status')).toContainText('Чтение недоступно');
    await expect(page.locator('.reference-manager')).toHaveJSProperty('inert', true);
    await expect(page.locator('#data-schema')).toBeEnabled();
});
