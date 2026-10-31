const { test, expect } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { readFileSync } = require('node:fs');

const login = process.env.E2E_USER;
const password = process.env.E2E_PASSWORD;

test('печать требует входа', async ({ page }) => {
    await page.goto('/print/actions?schema=test');
    await expect(page).toHaveURL('/login');
});

test('компактная печатная таблица сохраняет большие суммы и длинный текст', async ({ page }) => {
    const html = execFileSync(path.resolve('.tools/php/php.exe'), [path.join(__dirname, 'fixtures/print-report.php')], { encoding: 'utf8' });
    await page.route('**/print/layout-fixture', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto('/print/layout-fixture');
    await expect(page.locator('.operations thead th')).toHaveText(['Дата / №', 'Счёт / валюта', 'Назначение', 'Примечание', 'П', 'А', 'Приход', 'Расход']);
    await expect(page.locator('.operations tbody tr').first().locator('td').nth(2)).toHaveClass('classification');
    await expect(page.locator('.operations tbody tr').first().locator('td').nth(3)).toHaveClass('memo');
    await expect(page.locator('.totals thead th')).toHaveCount(6);
    await expect(page.locator('.operation-date').first()).toHaveText('15.01.26 12:00');
    await expect(page.locator('td[data-check-owner="user"]')).toHaveText(['П✓', '']);
    await expect(page.locator('td[data-check-owner="admin"]')).toHaveText(['', 'А✓']);
    await expect(page.locator('.operation-meta').first()).toHaveText('№ 123 · З');
    await expect(page.locator('.operation-meta').last()).toHaveText('№ 124');
    await expect(page.getByRole('columnheader', { name: 'Отметка пользователя' })).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Отметка администратора' })).toBeVisible();
    await expect(page.locator('.classification').first()).toHaveText('Направление → Операция → Уровень 1 → Уровень 2');
    await expect(page.locator('.memo').last()).toContainText('КОНЕЦ ПРИМЕЧАНИЯ');
    await expect(page.locator('.report-legend')).toContainText('З — защищённая');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.setViewportSize({ width: 703, height: 1000 }); // A4 minus 12 mm margins, at 96 dpi.
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.operations')).toHaveCSS('font-size', '10.6667px');
    await expect(page.locator('.operation-meta').first()).toHaveCSS('font-size', '9.33333px');
    await expect(page.locator('.operations tbody td').first()).toHaveCSS('border-left-width', '0px');
    const layout = await page.evaluate(() => ({
        fits: document.documentElement.scrollWidth <= innerWidth,
        numbersFit: [...document.querySelectorAll('.operations .money')].every(cell => cell.scrollWidth <= cell.clientWidth && getComputedStyle(cell).whiteSpace === 'nowrap'),
        marksFit: [...document.querySelectorAll('td.operation-check')].every(cell => cell.scrollWidth <= cell.clientWidth),
        compactRowHeight: document.querySelector('.operations tbody tr').getBoundingClientRect().height,
        totalsFit: [...document.querySelectorAll('.totals td')].every(cell => cell.scrollWidth <= cell.clientWidth),
    }));
    expect(layout.fits).toBe(true);
    expect(layout.numbersFit).toBe(true);
    expect(layout.marksFit).toBe(true);
    expect(layout.totalsFit).toBe(true);
    expect(layout.compactRowHeight).toBeLessThan(100);
    const pdf = await page.pdf({ preferCSSPageSize: true });
    expect(pdf.length).toBeGreaterThan(1000);
});

test('ширины колонок и заголовки одинаковы с CSP хостинга и без неё', async ({ page }) => {
    const policy = readFileSync(path.resolve('public/.htaccess'), 'utf8').match(/Header always set Content-Security-Policy "([^"]+)"/)?.[1];
    expect(policy, 'Проверяется фактическая CSP из конфигурации хостинга').toBeTruthy();
    await page.setViewportSize({ width: 703, height: 1000 });
    await page.addInitScript(() => {
        window.cspViolations = [];
        document.addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.violatedDirective));
    });
    for (const [mode, characters] of [['small', 8], ['', 25], ['negative', 26]]) {
        const html = execFileSync(path.resolve('.tools/php/php.exe'), [path.join(__dirname, 'fixtures/print-report.php'), mode], { encoding: 'utf8' });
        const baseline = {};
        for (const protectedMode of [false, true]) {
            const url = `/print/csp-fixture-${mode || 'max'}-${protectedMode}`;
            await page.route(`**${url}`, route => route.fulfill({
                contentType: 'text/html; charset=utf-8', body: html,
                headers: protectedMode ? { 'Content-Security-Policy': policy } : {},
            }));
            const response = await page.goto(url);
            if (protectedMode) expect(response.headers()['content-security-policy']).toBe(policy);
            await expect(page.locator('[style]')).toHaveCount(0);
            await expect(page.locator(`.amount-column--${characters}`)).toHaveCount(2);
            for (const media of ['screen', 'print']) {
                await page.emulateMedia({ media });
                const dimensions = await page.evaluate(() => ({
                    columns: [...document.querySelectorAll('.amount-column')].map(column => getComputedStyle(column).width),
                    headerAlignments: [...document.querySelectorAll('thead th')].map(cell => getComputedStyle(cell).textAlign),
                    bodyAlignments: [...document.querySelectorAll('tbody tr:first-child > *')].map(cell => {
                        const align = getComputedStyle(cell).textAlign;
                        return align === 'start' ? 'left' : align;
                    }),
                    headers: [...document.querySelectorAll('.operations thead th')].map(cell => {
                        const rect = cell.getBoundingClientRect();
                        return { width: rect.width, height: rect.height };
                    }),
                    numbersFit: [...document.querySelectorAll('.operations .money')].every(cell => cell.scrollWidth <= cell.clientWidth),
                }));
                expect(dimensions.numbersFit).toBe(true);
                expect(dimensions.headerAlignments).toEqual(['left', 'left', 'left', 'left', 'center', 'center', 'right', 'right',
                    'left', 'right', 'right', 'right', 'right', 'right']);
                expect(dimensions.headerAlignments).toEqual(dimensions.bodyAlignments);
                if (protectedMode) expect(dimensions).toEqual(baseline[media]);
                else baseline[media] = dimensions;
            }
            expect(await page.evaluate(() => window.cspViolations)).toEqual([]);
            if (protectedMode) {
                const pdf = await page.pdf({ preferCSSPageSize: true });
                expect(pdf.length).toBeGreaterThan(1000);
            }
        }
    }
});

test('выбранные уровни назначения ссылаются на фильтры в шапке', async ({ page }) => {
    for (const [mode, expected] of [['filtered', '① → ② → ③ → ④'], ['partial', '① → Операция → ③ → Уровень 2']]) {
        const html = execFileSync(path.resolve('.tools/php/php.exe'), [path.join(__dirname, 'fixtures/print-report.php'), mode], { encoding: 'utf8' });
        await page.route(`**/print/fixture-${mode}`, route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
        await page.goto(`/print/fixture-${mode}`);
        await expect(page.locator('.classification')).toHaveText([expected, expected]);
        await expect(page.locator('.report-filters')).toContainText('① Направление: Направление');
        await expect(page.locator('.report-filters')).toContainText('③ Подоперация 1: Уровень 1');
        await expect(page.locator('.report-legend')).toContainText('ссылки на выбранные фильтры');
        await expect(page.locator('.memo').first()).toHaveText('Короткое примечание');
        await expect(page.locator('.memo').last()).toContainText('КОНЕЦ ПРИМЕЧАНИЯ');
        await page.emulateMedia({ media: 'print' });
        await expect(page.locator('.report-filters')).toBeVisible();
        const pdf = await page.pdf({ preferCSSPageSize: true });
        expect(pdf.length).toBeGreaterThan(1000);
    }
});

test('отчёт печатает оба потока, фильтры и итоги без интерфейса приложения', async ({ page, context }) => {
    test.skip(!login || !password, 'Задайте E2E_USER и E2E_PASSWORD');
    const request = context.request;
    expect((await request.post('/api/login', { data: { login, password } })).ok()).toBeTruthy();
    const me = await (await request.get('/api/me')).json();
    const headers = { 'X-CSRF-Token': me.csrf_token };
    const lookups = await (await request.get('/api/lookups')).json();
    test.skip(!lookups.accounts[0] || !lookups.currencies[0] || !lookups.suboperations_l2[0], 'Недостаточно справочников');
    const marker = `PRINT-E2E-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const memo = `${marker} <script>alert("test")</script> & длинное примечание\nВторая строка`;
    const ids = [];
    const params = new URLSearchParams({ from_date: '', to_date: '', memo: marker });
    try {
        for (const is_debit of [true, false]) {
            const response = await request.post('/api/actions', { headers, data: {
                account_id: lookups.accounts[0].id, currency_id: lookups.currencies[0].id,
                suboperation_id: lookups.suboperations_l2[0].id,
                action_date: '2026-01-15T12:00', amount: is_debit ? '123.45' : '23.40',
                is_debit, memo,
            } });
            expect(response.status()).toBe(201);
            ids.push((await response.json()).id);
        }
        await page.goto(`/?${params}`);
        await expect(page.locator('#print-actions')).toBeEnabled();
        await expect(page.locator('.dashboard__header #print-actions')).toHaveCount(1);
        await expect(page.locator('.operations-toolbar #print-actions')).toHaveCount(0);
        const originalViewport = page.viewportSize();
        for (const width of [320, 390, 768, 1280]) {
            await page.setViewportSize({ width, height: 900 });
            const print = page.getByRole('button', { name: 'Печать', exact: true });
            await expect(print).toBeVisible();
            const layout = await page.evaluate(() => {
                const button = document.querySelector('#print-actions').getBoundingClientRect();
                const schema = document.querySelector('#data-schema').getBoundingClientRect();
                return { onLeft: button.right <= schema.left, sameRow: Math.abs((button.top + button.bottom - schema.top - schema.bottom) / 2) < 2,
                    fits: document.documentElement.scrollWidth <= innerWidth };
            });
            expect(layout.onLeft).toBe(true);
            if (width < 480) expect(layout.sameRow).toBe(true);
            expect(layout.fits).toBe(true);
            if (width >= 1100) await expect(page.locator('.operations-toolbar')).toBeHidden();
            if (width < 480) await expect(page.locator('.operations-print__label')).toBeHidden();
        }
        await page.setViewportSize(originalViewport);
        const newPage = context.waitForEvent('page');
        await page.locator('#print-actions').click();
        const report = await newPage;
        await report.waitForLoadState();
        await expect(report).toHaveURL(/\/print\/actions\?/);
        await expect(report.locator('#operation-count')).toHaveText('2');
        await expect(report.locator('[data-operation-id]')).toHaveCount(2);
        await expect(report.locator('.operations')).toContainText(memo);
        await expect(report.locator('.totals')).toContainText('123,45');
        await expect(report.locator('.totals')).toContainText('23,40');
        await expect(report.locator('.totals')).toContainText('100,05');
        expect(await report.locator('script:not([src])').count()).toBe(0);
        await report.evaluate(() => { window.print = () => { window.printCalled = true; }; });
        await report.locator('#print-report').click();
        expect(await report.evaluate(() => window.printCalled)).toBe(true);
        await report.emulateMedia({ media: 'print' });
        await expect(report.locator('#print-report')).toBeHidden();
        // Chromium normalizes the default portrait orientation to just "a4".
        const pageSizes = await report.evaluate(() => [...document.styleSheets].flatMap(sheet => [...sheet.cssRules]).filter(rule => rule.type === CSSRule.PAGE_RULE).map(rule => rule.style.getPropertyValue('size').toLowerCase()));
        expect(pageSizes.some(size => /^a4(?: portrait)?$/.test(size))).toBe(true);
        const pdf = await report.pdf({ preferCSSPageSize: true });
        const mediaBox = /\/MediaBox\s*\[0 0 ([\d.]+) ([\d.]+)\]/.exec(pdf.toString('latin1'));
        expect(mediaBox).toBeTruthy();
        expect(Number(mediaBox[1])).toBeCloseTo(595, -1);
        expect(Number(mediaBox[2])).toBeCloseTo(842, -1);
        const screenControls = report.locator('.print-controls');
        for (let i = 0; i < await screenControls.count(); i++) await expect(screenControls.nth(i)).toBeHidden();
        await report.close();
        const mismatch = await request.get('/print/actions?schema=not_selected');
        expect(await mismatch.text()).toContain('Рабочая схема изменилась');
        expect((await request.post(`/print/actions?schema=${me.data_schema}`)).status()).toBe(405);
        const response = await request.get(`/print/actions?${params}&schema=${me.data_schema}`);
        expect(response.headers()['cache-control']).toBe('no-store');
    } finally {
        for (const id of ids) expect((await request.delete(`/api/actions/${id}`, { headers })).ok()).toBeTruthy();
    }
});
