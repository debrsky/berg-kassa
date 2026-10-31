const { defineConfig, devices } = require('@playwright/test');

process.loadEnvFile();

module.exports = defineConfig({
    testDir: './tests/e2e',
    timeout: 30_000,
    // The local PHP development server handles one request at a time.
    // CLI --workers (including test:load) still overrides this setting.
    workers: process.env.E2E_BASE_URL ? undefined : 1,
    reporter: [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:18090',
        trace: 'retain-on-failure',
    },
    webServer: process.env.E2E_BASE_URL ? undefined : {
        command: '.\\.tools\\php\\php.exe -S 127.0.0.1:18090 -t public public\\router.php',
        url: 'http://127.0.0.1:18090/login',
        reuseExistingServer: true,
    },
    projects: [
        { name: 'api', testMatch: /api\.spec\.js/ },
        { name: 'desktop', testIgnore: /api\.spec\.js/, use: { ...devices['Desktop Chrome'] } },
        { name: 'mobile', testIgnore: /api\.spec\.js/, use: { ...devices['Pixel 7'] } },
    ],
});
