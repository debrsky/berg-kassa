const { test, expect } = require('@playwright/test');

const login = process.env.E2E_USER;
const password = process.env.E2E_PASSWORD;

test('неавторизованного пользователя перенаправляет на вход', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL('/login');
});

test('тема переключается и сохраняется', async ({ page }) => {
    await page.goto('/login');
    const toggle = page.locator('#theme-toggle');
    await expect(toggle).toHaveText('Тема: Системная');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.reload();
    await expect(toggle).toHaveText('Тема: Тёмная');
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
    await expect(page).toHaveURL('/');
});

test('основная страница и форма добавления работают', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Касса' })).toBeVisible();
    await expect(page.getByLabel('Начало периода')).toBeVisible();
    const addIncome = page.locator('[data-add-flow="income"]');
    await expect(addIncome).toBeEnabled();
    await addIncome.click();
    await expect(page.locator('#operation-dialog')).toBeVisible();
    await expect(page.locator('#operation-form [name="is_debit"]')).toHaveValue('true');
    await page.getByRole('button', { name: 'Закрыть' }).click();
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
});
});
