import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'playwright-report/results.json' }]],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  // KeepGreen starts the shop itself (start-command); in CI Playwright must reuse it.
  webServer: { command: 'node server.mjs', url: 'http://127.0.0.1:4173/', reuseExistingServer: !process.env.CI || !!process.env.KEEPGREEN },
});
