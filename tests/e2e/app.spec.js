const { test, expect } = require('@playwright/test');

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

test('основная страница и форма добавления работают', async ({ page }) => {
    const me = await (await page.request.get('/api/me')).json();
    await expect(page.getByRole('heading', { name: 'Касса' })).toBeVisible();
    await expect(page.getByLabel('Начало периода')).toBeVisible();
    await expect(page.locator('#currency-summary table')).toBeVisible();
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
    await expect(page.locator('#operation-form [name="is_black"]')).toBeVisible({ visible: me.can_view_protected });
    await expect(page.locator('#operation-form [name="is_debit"]')).toHaveValue('true');
    await expect(page.locator('#operation-form [name="currency_id"] option:checked')).toHaveText('р.');
    expect(await page.locator('#operation-form [name="is_black"]').isChecked()).toBe(await protectedFilter.isChecked());
    await page.getByRole('button', { name: 'Закрыть' }).click();
});

test('поиск по примечанию применяется и сохраняется', async ({ page }) => {
    const memo = page.locator('#filters [name="memo"]');
    await memo.fill('аренда');
    await expect.poll(() => new URL(page.url()).searchParams.get('memo')).toBe('аренда');
    await page.reload();
    await expect(memo).toHaveValue('аренда');
    await expect(page.locator('#status')).toContainText('Найдено');
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
    await from.fill('2024-02-01');
    await to.focus();
    await to.press('Backspace');
    await expect(page).toHaveURL(/from_date=2024-02-01&to_date=/);
    await page.reload();
    await expect(from).toHaveValue('2024-02-01');
    await expect(to).toHaveValue('');
    await to.fill('2024-03-01');
    const validUrl = page.url();
    await from.fill('2024-03-02');
    await expect(to).toHaveJSProperty('validationMessage', 'Начало периода не может быть позже конца');
    expect(page.url()).toBe(validUrl);
    const summary = page.waitForResponse(response => response.url().includes('/api/action-summary?') && new URL(response.url()).searchParams.get('all_time') === '1');
    await preset.selectOption('all');
    expect((await summary).ok()).toBeTruthy();
    await expect(from).toHaveValue('');
    await expect(to).toHaveValue('');
    await page.reload();
    await expect(preset).toHaveValue('all');
    await expect(from).toHaveValue('');
    await page.locator('#reset-filters').click();
    await expect(page).not.toHaveURL(/all_time/);
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

test('дата открывает редактор существующей операции', async ({ page }) => {
    const dateButton = page.getByRole('button', { name: /Редактировать операцию от/ }).first();
    await expect(dateButton).toBeVisible();
    await dateButton.click();
    await expect(page.locator('#operation-dialog')).toBeVisible();
    await expect(page.locator('#delete-operation')).toBeVisible();
});

test('фильтр сохраняется в URL и восстанавливается после перезагрузки', async ({ page }) => {
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
    await page.getByRole('button', { name: 'Сбросить' }).click();
    await expect(page).not.toHaveURL(/account_id=/);
});

test('каскад не предлагает несовместимые уровни', async ({ page }) => {
    const filters = page.locator('#filters');
    await filters.locator('[name="direction_id"]').selectOption({ label: 'Гр' });
    const action = filters.locator('[name="action_type_id"]');
    await expect(action).toBeEnabled();
    await action.selectOption({ label: '(приходники)' });
    const sub1 = filters.locator('[name="suboperation_l1_id"]');
    await expect(sub1).toBeEnabled();
    const actionId = await action.inputValue();
    expect(actionId).not.toBe('');
});

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
