const { expect } = require('@playwright/test');
const { test, expandFilters } = require('./helpers');

const login = process.env.E2E_USER;
const password = process.env.E2E_PASSWORD;
const restrictedLogin = process.env.E2E_RESTRICTED_USER;
const restrictedPassword = process.env.E2E_RESTRICTED_PASSWORD;

test('неавторизованного пользователя перенаправляет на вход', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/login');
});

test('тема переключается и сохраняется', async ({ page }) => {
    await page.goto('/login');
    const toggle = page.locator('#theme-toggle');
    await expect(toggle).toHaveAttribute('title', 'Тема: Системная');
    await expect(toggle).toHaveCSS('width', '36px');
    await expect(toggle).toHaveCSS('height', '36px');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(toggle).toHaveAttribute('title', 'Тема: Тёмная');
    await expect(toggle).toHaveAccessibleName('Тема: Тёмная. Нажмите, чтобы переключить');
    await expect(toggle).toHaveCSS('width', '36px');
    await expect(toggle).toHaveCSS('height', '36px');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'system');
});

test('без JavaScript вход не отправляет пароль в URL', async ({ browser, baseURL }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
    const page = await context.newPage();
    try {
        await page.goto('/login');
        await expect(page.locator('noscript [role=alert]')).toContainText('включите JavaScript');
        await page.getByLabel('Логин').fill('audit-dummy');
        await page.getByLabel('Пароль').fill('dummy-password');
        let sent;
        await page.route('**/login', async route => {
            sent = route.request();
            await route.fulfill({ status: 200, body: 'Проверено' });
        });
        await page.getByRole('button', { name: 'Войти' }).click();
        await expect.poll(() => sent?.method()).toBe('POST');
        expect(new URL(sent.url()).search).toBe('');
        expect(sent.postData()).toContain('password=dummy-password');
    } finally {
        await context.close();
    }
});

test.describe('с авторизацией', () => {
test.beforeEach(async ({ page }) => {
    test.skip(!login || !password, 'Задайте E2E_USER и E2E_PASSWORD');
    await page.goto('/login');
    await page.getByLabel('Логин').fill(login);
    await page.getByLabel('Пароль').fill(password);
    await page.getByRole('button', { name: 'Войти' }).click();
    await expect(page).not.toHaveURL(/\/login$/);
    await page.waitForLoadState('load');
    await expect(page.locator('#status')).toContainText('Найдено');
});

test('дата новой операции учитывает применённый период фильтра', async ({ page }) => {
    const now = await page.evaluate(() => new Date(2026, 5, 15, 14, 35).getTime());
    await page.clock.setFixedTime(now);
    const cases = [
        ['2026-06-01', '2026-06-30', '2026-06-15'],
        ['2026-06-15', '2026-06-15', '2026-06-15'],
        ['2026-05-01', '2026-05-31', '2026-05-31'],
        ['2026-07-01', '2026-07-31', '2026-07-31'],
        ['', '2026-05-31', '2026-05-31'],
        ['', '2026-07-31', '2026-06-15'],
        ['2026-07-01', '', '2026-06-15'],
        ['', '', '2026-06-15'],
    ];
    for (const [from_date, to_date, expected] of cases) {
        await page.goto('/?' + new URLSearchParams({ from_date, to_date }));
        await expect(page.locator('#status')).toContainText('Найдено');
        for (const flow of ['income', 'expense']) {
            if (await page.locator('.operations-tabs').isVisible()) {
                await page.locator(`[data-flow-tab="${flow}"]`).click();
            }
            await page.locator(`[data-add-flow="${flow}"]`).click();
            const time = expected === '2026-06-15' ? '14:35' : '00:00';
            await expect(page.locator('#operation-form [name=action_date]')).toHaveValue(`${expected}T${time}`);
            await page.locator('#operation-dialog [data-close-dialog]').first().click();
        }
    }
});

test('ошибка выхода объявляется и позволяет повторить выход', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    for (const path of ['/', '/audit', '/users']) {
        await page.goto(path);
        await expect(page.locator('#status')).toContainText(/Найдено|Событий|Пользователей/);
        await page.route('**/api/logout', route => route.abort());
        await page.locator('#navigation > summary').click();
        await page.locator('#logout').click();
        await expect(page.locator('#status')).toHaveAttribute('role', 'status');
        await expect(page.locator('#status')).toHaveText('Не удалось выйти. Повторите попытку.');
        await page.unroute('**/api/logout');
    }
    expect(errors).toEqual([]);
    await page.locator('#navigation > summary').click();
    await page.locator('#logout').click();
    await expect(page).toHaveURL(/\/login$/);
});

test('контраст заголовков операций достаточен в обеих темах', async ({ page }) => {
    for (const theme of ['light', 'dark']) {
        const ratio = await page.evaluate(theme => {
            document.documentElement.dataset.theme = theme;
            const style = getComputedStyle(document.querySelector('.operation-panel__columns'));
            const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
                v /= 255;
                return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
            const a = luminance(style.color), b = luminance(style.backgroundColor);
            return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        }, theme);
        expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
});

test('сохранение справочника и пользователя блокирует повторный запрос', async ({ page }) => {
    for (const kind of ['references', 'users']) {
        await page.goto('/' + kind);
        await expect(page.locator('#status')).toContainText(/Схема|Пользователей/);
        const form = page.locator(kind === 'users' ? '#user-form' : '#reference-form');
        if (kind === 'users') {
            await page.locator('#new-user').click();
            await form.locator('[name=login]').fill('test-no-write');
            await form.locator('[name=data_schemas]').fill('vl');
            await form.locator('[name=password]').fill('test-no-write-password');
        } else {
            await page.locator('#reference-type').selectOption('currencies');
            await expect(page.locator('#reference-message')).not.toHaveText('Загрузка…');
            await page.locator('#new-reference').click();
            await form.locator('[name=name]').fill('test-no-write');
        }
        const url = kind === 'users' ? '**/api/users' : '**/api/references/currencies';
        let release;
        const pending = new Promise(resolve => release = resolve);
        let count = 0;
        await page.route(url, async route => {
            if (route.request().method() !== 'POST') return route.continue();
            count++;
            await pending;
            await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Тестовая ошибка"}' });
        });
        const submit = form.locator('[type=submit]');
        await submit.click();
        await expect.poll(() => count).toBe(1);
        await expect(submit).toBeDisabled();
        await form.evaluate(element => element.requestSubmit());
        release();
        await expect(submit).toBeEnabled();
        await expect(form.getByRole('status')).toHaveText('Тестовая ошибка');
        expect(count).toBe(1);
        await submit.click();
        await expect.poll(() => count).toBe(2);
        await expect(submit).toBeEnabled();
        await page.unroute(url);
    }
});

test('основная страница и форма добавления работают', async ({ page }) => {
    const me = await (await page.request.get('/api/me')).json();
    await expect(page.getByRole('heading', { name: 'Касса' })).toBeVisible();
    await expandFilters(page);
    await expect(page.getByLabel('Начало периода')).toBeVisible();
    const mobile = (page.viewportSize()?.width ?? 1280) < 480;
    await expect(page.locator('#currency-summary table')).toBeVisible({ visible: !mobile });
    await expect(page.locator('#currency-summary .summary-compact')).toBeVisible({ visible: mobile });
    await expect(page.getByRole('region', { name: 'Итоги и сальдо' })).toBeVisible();
    await expect(page.locator('.summary__header, #summary-count')).toHaveCount(0);
    await expect(page.locator('#direction-summary, .summary__details')).toHaveCount(0);
    const protectedFilter = page.locator('#filters [name="include_protected"]');
    await expect(protectedFilter).toBeVisible({ visible: me.can_view_protected });
    if (await protectedFilter.isVisible()) await protectedFilter.check();
    const addIncome = page.locator('[data-add-flow="income"]');
    await expect(addIncome).toBeEnabled();
    await addIncome.click();
    await expect(page.locator('#operation-dialog')).toBeVisible();
    await expect(page.locator('#operation-dialog')).toHaveAccessibleName(/Новая операция|Редактирование операции/);
    await expect(page.locator('#operation-form [name="is_black"]')).toBeVisible({ visible: me.can_view_protected });
    await expect(page.locator('#operation-form [name="is_debit"]')).toHaveValue('true');
    await expect(page.locator('#operation-form [name="currency_id"] option:checked')).toHaveText('р.');
    expect(await page.locator('#operation-form [name="is_black"]').isChecked()).toBe(await protectedFilter.isChecked());
    await page.getByRole('button', { name: 'Закрыть' }).click();
});

test('фильтры отметок в заголовках независимы', async ({ page }) => {
    test.skip(page.viewportSize().width < 800, 'На мобильном фильтры находятся в общей панели');
    const filters = page.locator('[data-check-filter="checked_user"]');
    await expect(filters).toHaveCount(2);
    await filters.first().click();
    await expect(filters).toHaveText(['✓', '—']);
    await expect.poll(() => new URL(page.url()).searchParams.get('income_checked_user')).toBe('1');
    await expect(page.locator('.summary-table th').filter({ hasText: 'Приход' })).toContainText('с учётом отметок');
    await expect(page.locator('.summary-table th').filter({ hasText: 'Расход' })).not.toContainText('с учётом отметок');
});

test('поиск по примечанию применяется и сохраняется', async ({ page }) => {
    await expandFilters(page);
    const memo = page.locator('#filters [name="memo"]');
    await memo.fill('аренда');
    await expect.poll(() => new URL(page.url()).searchParams.get('memo')).toBe('аренда');
    await page.reload();
    await expect(memo).toHaveValue('аренда');
    await expect(page.locator('#status')).toContainText('Найдено');
    await expandFilters(page);
    await memo.fill('50%_!');
    await memo.press('Enter');
    await expect.poll(() => new URL(page.url()).searchParams.get('memo')).toBe('50%_!');
    await memo.fill('');
    await expect.poll(() => new URL(page.url()).searchParams.has('memo')).toBe(false);
    await memo.fill('сброс');
    await page.locator('#reset-filters').click();
    await expect(memo).toHaveValue('');
    await expect.poll(() => new URL(page.url()).searchParams.has('memo')).toBe(false);
});

test('готовые периоды и проверка дат работают', async ({ page }) => {
    await expandFilters(page);
    await page.clock.setFixedTime(new Date(2024, 2, 1, 12));
    const preset = page.getByLabel('Период', { exact: true });
    const from = page.getByLabel('Начало периода', { exact: true });
    const to = page.getByLabel('Конец периода', { exact: true });
    for (const [value, start, end] of [
        ['today', '2024-03-01', '2024-03-01'],
        ['yesterday', '2024-02-29', '2024-02-29'],
        ['week', '2024-02-26', '2024-03-01'],
        ['month', '2024-03-01', '2024-03-01'],
        ['previous-month', '2024-02-01', '2024-02-29'],
        ['last30', '2024-02-01', '2024-03-01'],
    ]) {
        await preset.selectOption(value);
        await expect(from).toHaveValue(start);
        await expect(to).toHaveValue(end);
        await expect(page).toHaveURL(new RegExp(`from_date=${start}&to_date=${end}`));
    }
    await from.focus();
    await from.press('Backspace');
    expect(await from.evaluate(input => input.validity.badInput)).toBe(false);
    await expect(page).toHaveURL(/from_date=&to_date=2024-03-01/);
    await page.reload();
    await expect(from).toHaveValue('');
    await expect(to).toHaveValue('2024-03-01');
    await expandFilters(page);
    await from.fill('2024-02-01');
    await to.focus();
    await to.press('Backspace');
    await expect(page).toHaveURL(/from_date=2024-02-01&to_date=/);
    await page.reload();
    await expect(from).toHaveValue('2024-02-01');
    await expect(to).toHaveValue('');
    await expandFilters(page);
    await to.fill('2024-03-01');
    const validUrl = page.url();
    await from.fill('2024-03-02');
    await expect(to).toHaveJSProperty('validationMessage', 'Начало периода не может быть позже конца');
    expect(page.url()).toBe(validUrl);
    const summary = page.waitForResponse(response => {
        const params = new URL(response.url()).searchParams;
        return response.url().includes('/api/action-summary?') && params.get('from_date') === '' && params.get('to_date') === '';
    });
    await preset.selectOption('all');
    expect((await summary).ok()).toBeTruthy();
    await expect(from).toHaveValue('');
    await expect(to).toHaveValue('');
    await page.reload();
    await expect(preset).toHaveValue('all');
    await expect(from).toHaveValue('');
    await expandFilters(page);
    await page.locator('#reset-filters').click();
    await expect(preset).toHaveValue('');
    await expect(page).not.toHaveURL(/from_date=&to_date=/);
});

test('меню закрывается и позволяет перейти в справочники и выйти', async ({ page }) => {
    const menu = page.locator('#navigation');
    const toggle = menu.locator('summary');
    await expect(menu.locator('nav')).toBeHidden();
    await toggle.click();
    await expect(menu.locator('nav')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu.locator('nav')).toBeHidden();
    await expect(toggle).toBeFocused();
    await toggle.click();
    await page.getByRole('heading', { name: 'Касса', exact: true }).click();
    await expect(menu.locator('nav')).toBeHidden();
    await toggle.click();
    await menu.getByRole('link', { name: 'Справочники' }).click();
    await expect(page).toHaveURL(/\/references$/);
    await expect(menu.locator('nav')).toBeHidden();
    await expect(page.locator('#status')).toContainText('Схема');
    await toggle.click();
    await menu.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login$/);
});

test('ссылка на журнал соответствует праву и журнал открывается', async ({ page }) => {
    const me = await (await page.request.get('/api/me')).json();
    await page.locator('#navigation > summary').click();
    const link = page.locator('#audit-link');
    if (!me.can_view_protected) {
        await expect(link).toBeHidden();
        return;
    }
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByRole('heading', { name: 'Журнал аудита' })).toBeVisible();
    await expect(page.locator('#audit-rows tr')).not.toHaveCount(0);
});

test('пользователь без права защищённых операций не открывает страницу журнала', async ({ page }) => {
    test.skip(!restrictedLogin || !restrictedPassword, 'Задайте E2E_RESTRICTED_USER и E2E_RESTRICTED_PASSWORD');
    await page.request.post('/api/logout', { headers: { 'X-CSRF-Token': (await (await page.request.get('/api/me')).json()).csrf_token } });
    expect((await page.request.post('/api/login', { data: { login: restrictedLogin, password: restrictedPassword } })).ok()).toBeTruthy();
    expect((await (await page.request.get('/api/me')).json()).can_view_protected).toBe(false);
    expect((await page.goto('/audit')).status()).toBe(403);
    expect((await page.goto('/users')).status()).toBe(403);
    await page.goto('/references');
    await expect(page.locator('#reference-list option')).not.toHaveCount(0);
    await page.locator('#navigation > summary').click();
    await expect(page.locator('#audit-link')).toBeHidden();
    await expect(page.locator('#users-link')).toBeHidden();
    await expect(page.locator('#new-reference')).toBeHidden();
    await expect(page.locator('#reference-form')).toBeHidden();
    await page.locator('#reference-type').selectOption('operation_tree');
    await expect(page.locator('#reference-hierarchy')).toBeVisible();
    for (const button of await page.locator('[data-add-hierarchy], [data-edit-hierarchy]').all()) {
        await expect(button).toBeHidden();
    }

});

test('ссылка на управление пользователями соответствует праву', async ({ page }) => {
    const me = await (await page.request.get('/api/me')).json();
    await page.locator('#navigation > summary').click();
    const link = page.locator('#users-link');
    if (!me.can_view_protected) {
        await expect(link).toBeHidden();
        return;
    }
    await expect(link).toBeVisible();
    await link.click();
    await expect(page.getByRole('heading', { name: 'Пользователи' })).toBeVisible();
    await expect(page.locator('#user-rows tr')).not.toHaveCount(0);
});

test('форма операции помещается по высоте на экране компьютера', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 0) < 800, 'Десктопная компоновка');
    for (const [width, height] of [[1024, 768], [1366, 768], [1280, 720]]) {
        await page.setViewportSize({ width, height });
        await page.locator('[data-add-flow="income"]').click();
        const dialog = page.locator('#operation-dialog');
        const fits = () => dialog.evaluate(element =>
            element.scrollHeight <= element.clientHeight && element.scrollWidth <= element.clientWidth);
        expect(await fits()).toBe(true);
        await page.locator('#operation-posting > summary').click();
        await expect(page.locator('#operation-posting')).toHaveAttribute('open', '');
        expect(await fits()).toBe(true);
        await page.locator('#operation-form-error').evaluate(element => { element.textContent = 'Проверьте обязательные поля'; });
        expect(await fits()).toBe(true);
        await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
    }
});

test('дата открывает редактор существующей операции', async ({ page, withActionFixture }) => {
    await withActionFixture(page.request, async ({ id, action, query }) => {
        await page.goto(`/?${query}`);
        await expect(page.locator('#status')).toHaveText('Найдено 1 операций');
        if (await page.locator('.operations-tabs').isVisible()) await page.locator('[data-flow-tab="income"]').click();
        if ((page.viewportSize()?.width ?? 1280) < 480) await page.setViewportSize({ width: 320, height: 700 });
        const dateButton = page.locator('#income-panel').getByRole('button', { name: /Редактировать операцию от/ });
        await expect(dateButton).toHaveCount(1);
        const unobstructed = await dateButton.evaluate(button => {
            const rect = button.getBoundingClientRect();
            return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        });
        expect(unobstructed, 'Длинная валюта и отметки не должны перекрывать кнопку даты').toBe(true);
        await dateButton.click();
        await expect(page.locator('#operation-dialog')).toBeVisible();
        await expect(page.locator('#delete-operation')).toBeVisible();
        await expect(page.locator('#operation-form [name=id]')).toHaveValue(String(id));
        await expect(page.locator('#operation-form [name=memo]')).toHaveValue(action.memo);
        await expect(page.locator('#operation-form [name=amount]')).toHaveValue(action.amount);
        if ((page.viewportSize()?.width ?? 0) >= 1000) {
            expect(await page.locator('#operation-dialog').evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
        }
    });
});

test('фильтр сохраняется в URL и восстанавливается после перезагрузки', async ({ page }) => {
    await expandFilters(page);
    const account = page.locator('#filters [name="account_id"]');
    await expect(account.locator('option')).not.toHaveCount(1);
    await account.selectOption({ index: 1 });
    const selected = await account.inputValue();
    await expect(page).toHaveURL(new RegExp(`account_id=${selected}`));
    await page.locator('[data-add-flow="income"]').click();
    await expect(page.locator('#operation-form [name="account_id"]')).toHaveValue(selected);
    await page.getByRole('button', { name: 'Закрыть' }).click();
    await page.reload();
    await expect(page.locator('#filters [name="account_id"]')).toHaveValue(selected);
    await expandFilters(page);
    await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
    await expect(page).not.toHaveURL(/account_id=/);
});

test('смена схемы сбрасывает фильтры', async ({ page }) => {
    await expandFilters(page);
    await page.locator('#filters [name="memo"]').fill('не переносить');
    const schema = page.locator('#data-schema');
    await schema.evaluate(select => select.add(new Option('xyz', 'xyz')));
    await page.route('**/api/schema', route => route.fulfill({ json: {} }));
    await schema.selectOption('xyz');
    await expect.poll(() => page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('data-schema:'))?.[1])).toBe('xyz');
    await expect(page.locator('#filters [name="memo"]')).toHaveValue('');
    await expect(page).not.toHaveURL(/memo=/);
    await expect(page.locator('#period-preset')).toHaveValue('');
});

test('мобильная версия использует карточки, сворачиваемые фильтры и нижние действия', async ({ page }) => {
    test.skip((page.viewportSize()?.width ?? 1000) > 479, 'Только мобильная компоновка');
    await page.setViewportSize({ width: 320, height: 568 });
    const toggle = page.locator('#filter-toggle');
    await expect(page.locator('.dashboard__title')).toContainText('Берг Касса');
    await expect(page.locator('#navigation > summary')).toHaveCSS('font-size', '0px');
    await expect(page.locator('#data-schema')).toHaveCSS('text-transform', 'uppercase');
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('Фильтры');
    await expect(toggle).toContainText('▾');
    await expect(page.locator('#filter-fields')).toBeHidden();
    await toggle.click();
    await expect(toggle).toContainText('Скрыть фильтры');
    await expect(toggle).toContainText('▴');
    await expect(page.locator('#filter-fields')).toBeVisible();
    const summary = page.locator('.summary');
    await expect(summary).toBeVisible();
    await expect(summary).toHaveCSS('position', 'fixed');
    await expect(summary).toHaveCSS('bottom', '0px');
    expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(summary.locator('.summary-table')).toBeHidden();
    const totals = summary.locator('.summary-compact__details');
    await expect(totals).not.toHaveAttribute('open', '');
    await totals.locator('summary').click();
    await expect(totals).toHaveAttribute('open', '');
    await expect(totals.locator('.summary-compact__breakdown:not([hidden])')).toBeVisible();
    await expect(page.locator('.operation-panel--active .operation-panel__columns-scroll')).toBeHidden();
    await expect(page.locator('.operation-panel--active .operation-panel__body')).toHaveCSS('touch-action', 'pan-y pinch-zoom');
    const swipeArea = page.locator('.operation-panel--active .operation-panel__body');
    await page.locator('[data-flow-tab="income"]').click();
    await swipeArea.dispatchEvent('pointerdown', { pointerId: 1, clientX: 250, clientY: 150 });
    await swipeArea.dispatchEvent('pointerup', { pointerId: 1, clientX: 180, clientY: 230 });
    await expect(page.locator('[data-flow-tab="income"]')).toHaveAttribute('aria-selected', 'true');
    await swipeArea.dispatchEvent('pointerdown', { pointerId: 2, clientX: 250, clientY: 150 });
    await swipeArea.dispatchEvent('pointerup', { pointerId: 2, clientX: 150, clientY: 160 });
    await expect(page.locator('[data-flow-tab="expense"]')).toHaveAttribute('aria-selected', 'true');
    await swipeArea.dispatchEvent('pointerdown', { pointerId: 3, clientX: 100, clientY: 150 });
    await swipeArea.dispatchEvent('pointerup', { pointerId: 3, clientX: 200, clientY: 160 });
    await expect(page.locator('[data-flow-tab="income"]')).toHaveAttribute('aria-selected', 'true');
    await page.locator('.operation-panel--active [data-add-flow="income"]').click();
    await expect(page.locator('.operation-form__section')).toHaveText(['Основное', 'Классификация', 'Дополнительно']);
});

test('каскад не предлагает несовместимые уровни', async ({ page }) => {
    await expandFilters(page);
    const lookups = await (await page.request.get('/api/lookups')).json();
    const actionRecord = lookups.action_types.find(item => item.direction_id);
    test.skip(!actionRecord, 'Нет связанной операции для проверки');
    const filters = page.locator('#filters');
    await filters.locator('[name="direction_id"]').selectOption(String(actionRecord.direction_id));
    const action = filters.locator('[name="action_type_id"]');
    await expect(action).toBeEnabled();
    await action.selectOption(String(actionRecord.id));
    const sub1 = filters.locator('[name="suboperation_l1_id"]');
    await expect(sub1).toBeEnabled();
    expect(await action.inputValue()).toBe(String(actionRecord.id));
    const actual = await action.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean).sort());
    const expected = lookups.action_types
        .filter(item => String(item.direction_id) === String(actionRecord.direction_id))
        .map(item => String(item.id)).sort();
    expect(actual).toEqual(expected);
});

test('каскад автоматически выбирает уровни из дефисов', async ({ page }) => {
    const lookups = await (await page.request.get('/api/lookups')).json();
    const direction = { id: 2000000000, name: 'Тест автоподстановки' };
    const ids = { action: 2000000001, sub1: 2000000002, sub2: 2000000003 };
    lookups.directions.push(direction);
    lookups.directions.push({ id: 2000000007, name: '---' });
    lookups.action_types.push({ id: ids.action, direction_id: direction.id, name: '---' });
    lookups.action_types.push({ id: 2000000004, direction_id: direction.id, name: 'Другой вариант' });
    lookups.suboperations_l1.push({ id: ids.sub1, action_type_id: ids.action, name: '--' });
    lookups.suboperations_l1.push({ id: 2000000005, action_type_id: ids.action, name: 'Другой вариант' });
    lookups.suboperations_l2.push({ id: ids.sub2, suboperation_l1_id: ids.sub1, name: '-' });
    lookups.suboperations_l2.push({ id: 2000000006, suboperation_l1_id: ids.sub1, name: 'Другой вариант' });
    await page.route('**/api/lookups', route => route.fulfill({ json: lookups }));
    await page.reload();
    await expect(page.locator('#status')).toContainText('Найдено');

    await expandFilters(page);
    const filters = page.locator('#filters');
    await expect(filters.locator('[name="direction_id"]')).toHaveValue('');
    await filters.locator('[name="direction_id"]').selectOption(String(direction.id));
    await expect(filters.locator('[name="action_type_id"]')).toHaveValue(String(ids.action));
    await expect(filters.locator('[name="suboperation_l1_id"]')).toHaveValue(String(ids.sub1));
    await expect(filters.locator('[name="suboperation_l2_id"]')).toHaveValue(String(ids.sub2));

    await page.locator('[data-add-flow="income"]').click();
    const dialog = page.locator('#operation-form');
    await expect(dialog.locator('[name="direction_id"]')).toHaveValue(String(direction.id));
    await expect(dialog.locator('[name="action_type_id"]')).toHaveValue(String(ids.action));
    await expect(dialog.locator('[name="suboperation_l1_id"]')).toHaveValue(String(ids.sub1));
    await expect(dialog.locator('[name="suboperation_id"]')).toHaveValue(String(ids.sub2));
});

for (const singleOption of [false, true]) {
    test(`каскад сохраняет ручной выбор «Все»: ${singleOption ? 'единственный вариант' : 'вариант из дефисов'}`, async ({ page }) => {
        const lookups = await (await page.request.get('/api/lookups')).json();
        const names = ['direction_id', 'action_type_id', 'suboperation_l1_id', 'suboperation_l2_id'];
        const sources = ['directions', 'action_types', 'suboperations_l1', 'suboperations_l2'];
        const ids = [2000000100, 2000000101, 2000000102, 2000000103];
        sources.forEach((source, index) => {
            const parent = index ? { [names[index - 1]]: ids[index - 1] } : {};
            lookups[source].push({ id: ids[index], name: singleOption ? 'Единственный вариант' : '---', ...parent });
            if (index && !singleOption) {
                lookups[source].push({ id: ids[index] + 10, name: 'Другой вариант', ...parent });
            }
        });
        await page.route('**/api/lookups', route => route.fulfill({ json: lookups }));
        await page.reload();
        await expect(page.locator('#status')).toContainText('Найдено');
        await expandFilters(page);
        const filters = page.locator('#filters');
        const field = index => filters.locator(`[name="${names[index]}"]`);
        await field(0).selectOption(String(ids[0]));

        for (let index = 3; index >= 1; index--) {
            await expect(field(index)).toHaveValue(String(ids[index]));
            await field(index).selectOption('');
            await expect(field(index)).toHaveValue('');
            for (let parent = 0; parent < index; parent++) {
                await expect(field(parent)).toHaveValue(String(ids[parent]));
            }
            for (let child = index + 1; child < names.length; child++) {
                await expect(field(child)).toHaveValue('');
                await expect(field(child)).toBeDisabled();
            }
            // Изменение несвязанного фильтра не должно отменять ручной выбор.
            await filters.locator('[name="memo"]').fill('проверка');
            await filters.locator('[name="memo"]').press('Enter');
            await expect(field(index)).toHaveValue('');
            await filters.locator('[name="memo"]').fill('');

            // Повторный выбор родителя снова запускает автовыбор потомков.
            await field(index).selectOption(String(ids[index]));
            for (let child = index + 1; child < names.length; child++) {
                await expect(field(child)).toHaveValue(String(ids[child]));
                await expect(field(child)).toBeEnabled();
            }
        }
    });
}

test('проводка раскрывается и фильтрует подоперации 2', async ({ page }) => {
    const lookups = await (await page.request.get('/api/lookups')).json();
    const sub1 = lookups.suboperations_l1.find(item => lookups.suboperations_l2.some(child => String(child.suboperation_l1_id) === String(item.id)));
    const action = lookups.action_types.find(item => String(item.id) === String(sub1?.action_type_id));
    test.skip(!sub1 || !action, 'Нет связанной подоперации для проверки');
    await page.locator('[data-add-flow="income"]').click();
    const dialog = page.locator('#operation-form');
    await dialog.locator('[name="direction_id"]').selectOption(String(action.direction_id));
    await dialog.locator('[name="action_type_id"]').selectOption(String(action.id));
    await dialog.locator('[name="suboperation_l1_id"]').selectOption(String(sub1.id));
    await dialog.locator('#operation-posting summary').click();
    await expect(dialog.locator('#operation-posting')).toHaveAttribute('open', '');
    const actual = (await dialog.locator('[name="posting_suboperation_id"] option').evaluateAll(options => options.map(option => option.value).filter(Boolean))).sort();
    const expected = lookups.suboperations_l2.filter(item => String(item.suboperation_l1_id) === String(sub1.id)).map(item => String(item.id)).sort();
    expect(actual).toEqual(expected);
});

test('связанные справочники и поиск работают', async ({ page }) => {
    await page.goto('/references');
    await page.getByLabel('Справочник').selectOption('operation_tree');
    await page.getByLabel('Направление').selectOption({ label: 'Гр' });
    await expect(page.getByLabel('Операции', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Подоперации 1', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Подоперации 2', { exact: true })).toBeVisible();

    const operations = page.getByLabel('Операции', { exact: true });
    const names = await operations.locator('option').allTextContents();
    const firstName = names.find(name => !name.startsWith('Без названия'));
    test.skip(!firstName, 'В выбранной схеме нет именованных операций');
    await page.getByLabel('Поиск операций').fill(firstName.replace(/ \(ID:.*$/, ''));
    await expect(operations.locator('option')).not.toHaveCount(0);
    await operations.selectOption({ index: 0 });
    await page.getByLabel('Редактировать операцию').click();
    await expect(page.getByLabel('Название')).toBeVisible();

    const sub2 = page.getByLabel('Подоперации 2', { exact: true });
    if (await sub2.locator('option').count()) {
        await sub2.selectOption({ index: 0 });
        const sub2Id = await sub2.inputValue();
        await page.getByLabel('Редактировать подоперацию 2').click();
        const selected = await (await page.request.get('/api/lookups')).json();
        const record = selected.suboperations_l2.find(item => String(item.id) === sub2Id);
        await expect(page.getByLabel('Примечание')).toHaveValue(record?.memo || '');
    }
});
});
