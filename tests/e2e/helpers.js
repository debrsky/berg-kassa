const { test: base, expect } = require('@playwright/test');
const { randomUUID } = require('node:crypto');

async function expandFilters(page) {
    const toggle = page.locator('#filter-toggle');
    if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}

// All records are synthetic, including references. Register teardown before setup
// so cleanup has Playwright's separate fixture-teardown budget even after a test timeout.
async function createActionFixture(request, run, registerCleanup) {
    const meResponse = await request.get('/api/me');
    expect(meResponse.ok()).toBeTruthy();
    const me = await meResponse.json();
    const headers = { 'X-CSRF-Token': me.csrf_token };
    const marker = `E2E-${randomUUID()}`;
    const created = [];
    registerCleanup(async () => {
        const failures = [];
        for (const url of created.reverse()) {
            try {
                const response = await request.delete(url, { headers });
                if (!response.ok()) failures.push(`${url}: HTTP ${response.status()}`);
            } catch (error) {
                failures.push(`${url}: ${error.message}`);
            }
        }
        expect(failures, 'Все временные записи должны быть удалены').toEqual([]);
    });
    const create = async (url, data) => {
        const response = await request.post(url, { headers, data });
        expect(response.status()).toBe(201);
        const { id } = await response.json();
        expect(id).toBeTruthy();
        created.push(`${url}/${id}`);
        return id;
    };
    const currencyId = await create('/api/references/currencies', { name: `${marker}-валюта` });
    const accountId = await create('/api/references/accounts', { name: `${marker}-счёт`, currency_id: currencyId });
    const directionId = await create('/api/references/directions', { name: `${marker}-направление` });
    const actionTypeId = await create('/api/references/action_types', { name: `${marker}-операция`, direction_id: directionId });
    const suboperationL1Id = await create('/api/references/suboperations_l1', { name: `${marker}-подоперация-1`, action_type_id: actionTypeId });
    const suboperationL2Id = await create('/api/references/suboperations_l2', { name: `${marker}-подоперация-2`, suboperation_l1_id: suboperationL1Id });
    const action = {
        account_id: accountId, currency_id: currencyId, suboperation_id: suboperationL2Id,
        action_date: '2026-01-15T12:00', amount: '123.45', exchange_rate: '1',
        is_debit: true, is_black: false, memo: marker,
    };
    const id = await create('/api/actions', action);
    const query = new URLSearchParams({
        from_date: '2026-01-15', to_date: '2026-01-15', memo: marker,
        account_id: String(accountId), currency_id: String(currencyId), direction_id: String(directionId),
        action_type_id: String(actionTypeId), suboperation_l1_id: String(suboperationL1Id),
        suboperation_l2_id: String(suboperationL2Id),
    });
    return await run({ id, action, accountId, headers, query });
}

const test = base.extend({
    // Both contexts must outlive teardown: UI tests pass page.request, API tests pass request.
    withActionFixture: async ({ request, context }, use) => {
        const cleanups = [];
        try {
            await use((apiRequest, run) => createActionFixture(apiRequest, run, cleanup => cleanups.push(cleanup)));
        } finally {
            for (const cleanup of cleanups.reverse()) await cleanup();
        }
    },
});

module.exports = { test, expandFilters };
