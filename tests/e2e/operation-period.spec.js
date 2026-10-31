const { expect } = require('@playwright/test');
const { test } = require('./helpers');

test('период операций: настройка и просмотр закрытой операции', async ({ page, request, withActionFixture }) => {
    test.skip(!process.env.E2E_USER || !process.env.E2E_PASSWORD, 'Нужен E2E-администратор');
    expect((await request.post('/api/login', { data: { login: process.env.E2E_USER, password: process.env.E2E_PASSWORD } })).ok()).toBeTruthy();
    const admin = await (await request.get('/api/me')).json();
    test.skip(!admin.can_view_protected, 'Нужен администратор');
    const headers = { 'X-CSRF-Token': admin.csrf_token };
    await page.goto('/login');
    await page.getByLabel('Логин').fill(process.env.E2E_USER);
    await page.getByLabel('Пароль').fill(process.env.E2E_PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.waitForURL('/');
    await page.goto('/users');
    const settings = page.locator('#operation-settings-form');
    await expect(settings.getByRole('button', { name: 'Сохранить период' })).toBeEnabled();
    await expect(page.locator('#operation-settings-timezone')).toContainText(admin.server_timezone);
    const layout = await settings.evaluate(element => {
        const field = element.querySelector('input').getBoundingClientRect();
        const button = element.querySelector('button').getBoundingClientRect();
        return { width: element.getBoundingClientRect().width, fieldWidth: field.width, buttonWidth: button.width, fieldBottom: field.bottom, buttonBottom: button.bottom };
    });
    expect(layout.width).toBeLessThanOrEqual(672);
    expect(layout.fieldWidth).toBeLessThanOrEqual(128);
    expect(layout.buttonWidth).toBeLessThan(layout.width);
    if (page.viewportSize().width >= 768) expect(Math.abs(layout.fieldBottom - layout.buttonBottom)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await settings.getByRole('button', { name: 'Сохранить период' }).click();
    await expect(page.locator('#operation-settings-message')).toHaveText('Период сохранён');
    const login = `E2E-period-ui-${Date.now()}`;
    const password = `E2E-password-${Date.now()}`;
    let userId;
    try {
        const created = await request.post('/api/users', { headers, data: { login, password, data_schemas: [admin.data_schema] } });
        expect(created.status()).toBe(201);
        userId = (await created.json()).id;
        const pageAdmin = await (await page.request.get('/api/me')).json();
        expect((await page.request.post('/api/logout', { headers: { 'X-CSRF-Token': pageAdmin.csrf_token } })).ok()).toBeTruthy();
        await page.goto('/login');
        await page.getByLabel('Логин').fill(login);
        await page.getByLabel('Пароль').fill(password);
        await page.getByRole('button', { name: 'Войти' }).click();
        await page.waitForURL('/');
        const me = await (await page.request.get('/api/me')).json();
        await withActionFixture(request, async ({ id, action, query }) => {
            const date = new Date(me.operation_edit_from + 'T00:00:00Z');
            date.setUTCDate(date.getUTCDate() - 1);
            const oldDate = date.toISOString().slice(0, 10);
            expect((await request.put(`/api/actions/${id}`, { headers, data: { ...action, action_date: oldDate + 'T12:00' } })).ok()).toBeTruthy();
            query.set('from_date', oldDate);
            query.set('to_date', oldDate);
            await page.goto('/?' + query);
            await page.locator('.operation-row__date').first().click();
            await expect(page.locator('#operation-form-title')).toHaveText('Просмотр операции');
            await expect(page.locator('#operation-form [name=action_date]')).toBeDisabled();
            await expect(page.locator('#operation-form [type=submit]')).toBeDisabled();
            await expect(page.locator('#delete-operation')).toBeDisabled();
            await expect(page.locator('#operation-form-error')).toContainText('Изменения операций доступны с');
            await page.locator('#operation-form [data-close-dialog]').first().click();
            await expect(page.locator('input[data-check=user]').first()).toBeEnabled();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
        });
    } finally {
        if (userId) expect((await request.delete(`/api/users/${userId}`, { headers })).ok()).toBeTruthy();
    }
});
