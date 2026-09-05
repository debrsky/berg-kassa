const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
    test.skip(!process.env.E2E_USER || !process.env.E2E_PASSWORD, 'Нет тестовой учётной записи');
    const login = await page.request.post('/api/login', { data: { login: process.env.E2E_USER, password: process.env.E2E_PASSWORD } });
    expect(login.ok()).toBeTruthy();
});

test('фильтры ждут справочники, NULL отличается от нулевой суммы', async ({ page }) => {
    let release;
    const pending = new Promise(resolve => release = resolve);
    await page.route('**/api/lookups', async route => { await pending; await route.continue(); });
    await page.route('**/api/actions?**', route => route.fulfill({ json: {
        total: 2,
        items: [null, 0].map((amount, i) => ({ id: i + 1, amount, action_date: '2026-01-01', currency: 'р.', account: 'Тест', memo: null })),
    } }));
    await page.goto('/?from_date=2026-01-01&to_date=2026-01-31&memo=тест');
    await expect(page.locator('#filters [name=memo]')).toBeDisabled();
    await expect(page.locator('#reset-filters')).toBeDisabled();
    await expect(page.locator('#data-schema')).toBeDisabled();
    release();
    await expect(page.locator('#filters [name=memo]')).toBeEnabled();
    await expect(page.locator('#filters [name=memo]')).toHaveValue('тест');
    await expect(page.locator('#filters [name=from_date]')).toHaveValue('2026-01-01');
    await expect(page.locator('#income-panel [data-operation-id="1"] .operation-row__amount')).toHaveText('— р.');
    await expect(page.locator('#income-panel [data-operation-id="2"] .operation-row__amount')).toHaveText('0,00 р.');
    if ((page.viewportSize()?.width ?? 1000) <= 479) {
        const card = page.locator('#income-panel [data-operation-id="1"]');
        expect((await card.boundingBox()).height).toBe(128);
        await expect(card).not.toHaveAttribute('role', 'button');
        const date = card.locator('.operation-row__date');
        expect((await date.boundingBox()).height).toBeGreaterThanOrEqual(44);
        await date.click();
        await expect(page.locator('#operation-dialog')).toBeVisible();
    }
});

for (const fail of [false, true]) {
    test(`справочники игнорируют устаревший ${fail ? 'отказ' : 'ответ'}`, async ({ page }) => {
        await page.goto('/references');
        await expect(page.locator('#status')).toContainText('Схема');
        let release;
        const pending = new Promise(resolve => release = resolve);
        let started = false;
        await page.route('**/api/references/currencies', async route => {
            started = true;
            await pending;
            await route.fulfill(fail ? { status: 500, json: { error: 'Старый отказ' } } : { json: [{ id: 999, name: 'Старый ответ', memo: '' }] });
        });
        await page.route('**/api/references/directions', route => route.fulfill({ json: [{ id: 998, name: 'Новый ответ', memo: '' }] }));
        await page.locator('#reference-type').selectOption('currencies');
        await expect.poll(() => started).toBe(true);
        await page.locator('#reference-type').selectOption('directions');
        await expect(page.locator('#reference-list')).toContainText('Новый ответ');
        const old = page.waitForResponse(r => r.url().endsWith('/api/references/currencies'));
        release();
        await (await old).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(page.locator('#reference-list')).toContainText('Новый ответ');
        await expect(page.locator('#reference-message')).not.toContainText('Старый');
    });

    test(`журнал игнорирует устаревший ${fail ? 'отказ' : 'ответ'}`, async ({ page }) => {
        const me = await (await page.request.get('/api/me')).json();
        test.skip(!me.can_view_protected, 'Нет доступа к журналу');
        await page.goto('/audit');
        await expect(page.locator('#status')).toContainText('Событий');
        let release;
        const pending = new Promise(resolve => release = resolve);
        let started = false;
        await page.route('**/api/audit-log?**', async route => {
            const old = new URL(route.request().url()).searchParams.get('login') === 'old';
            if (old) { started = true; await pending; }
            await route.fulfill(old && fail ? { status: 500, json: { error: 'Старый отказ' } } : { json: {
                total: 1, events: [], items: [{ created_at: '2026-01-01T00:00:00Z', event: 'login.success', login: old ? 'Старый ответ' : 'Новый ответ', details: {} }],
            } });
        });
        await page.locator('#audit-filter [name=login]').fill('old');
        await page.locator('#audit-filter [type=submit]').click();
        await expect.poll(() => started).toBe(true);
        await page.locator('#audit-filter [name=login]').fill('new');
        await page.locator('#audit-filter [type=submit]').click();
        await expect(page.locator('#audit-rows')).toContainText('Новый ответ');
        const old = page.waitForResponse(r => r.url().includes('login=old'));
        release();
        await (await old).finished();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await expect(page.locator('#audit-rows')).toContainText('Новый ответ');
        await expect(page.locator('#status')).toHaveText('Событий: 1');
    });
}
