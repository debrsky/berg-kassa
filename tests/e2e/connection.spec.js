const { test, expect } = require('@playwright/test');

test('сигналы сети и подтверждение связи сервером', async ({ page, context }) => {
    await page.goto('/login');
    const banner = page.locator('.connection-warning');
    await context.setOffline(true);
    await expect(banner).toContainText('Нет подключения');
    await context.setOffline(false);
    await expect(banner).toContainText('пока не подтверждена');
    await page.route('**/api/probe', route => route.fulfill({ json: {} }));
    await page.evaluate(() => connectionRequest('/api/probe'));
    await expect(banner).toBeHidden();
});

test('задержка не отменяет запрос и не скрывается чужим ответом', async ({ page }) => {
    await page.goto('/login');
    await page.clock.install();
    let release;
    const gate = new Promise(resolve => release = resolve);
    let count = 0;
    await page.route('**/api/slow', async route => {
        count++;
        await gate;
        await route.fulfill({ json: {} });
    });
    await page.route('**/api/fast', route => route.fulfill({ json: {} }));
    await page.evaluate(() => { window.pendingRequest = connectionRequest('/api/slow'); });
    await expect.poll(() => count).toBe(1);
    await page.clock.runFor(10_001);
    const banner = page.locator('.connection-warning');
    await expect(banner).toContainText('Ответ задерживается');
    await page.evaluate(() => connectionRequest('/api/fast'));
    await expect(banner).toBeVisible();
    release();
    await page.evaluate(() => window.pendingRequest);
    await expect(banner).toBeHidden();
    expect(count).toBe(1);
});

test('неизвестный результат записи, ошибка чтения и отмена поиска', async ({ page }) => {
    await page.goto('/login');
    let writes = 0;
    await page.route('**/api/actions', route => { writes++; return route.abort(); });
    const message = await page.evaluate(() => connectionRequest('/api/actions', { method: 'POST' }).catch(e => e.message));
    expect(message).toContain('Действие могло выполниться');
    await expect(page.locator('.connection-warning')).toContainText('Проверьте список');
    expect(writes).toBe(1);
    await page.route('**/api/read', route => route.abort());
    await page.evaluate(() => connectionRequest('/api/read').catch(() => {}));
    await expect(page.locator('.connection-warning')).toContainText('Не удалось получить ответ');
    await page.route('**/api/ok', route => route.fulfill({ json: {} }));
    await page.evaluate(() => connectionRequest('/api/ok'));
    await page.evaluate(() => {
        const controller = new AbortController();
        controller.abort();
        return connectionRequest('/api/ok', { signal: controller.signal }).catch(e => e.name);
    });
    await expect(page.locator('.connection-warning')).toBeHidden();
});
