import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  // Run test files in parallel with multiple workers. Previously CI used a
  // single worker which serialised everything and pushed total e2e time
  // over 10 minutes. GitHub-hosted runners have 4 cores; 2 workers is a
  // safe default that halves the wall time without oversubscribing.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Single retry catches genuine flakes without tripling the budget.
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  // Timeout per test. Goldmann tests that walk through the reaction-time
  // calibration legitimately need ~45 s each; the default 30 s was firing
  // on CI under load and producing noise in the summary. Bumping to 60 s
  // gives headroom without hiding real stalls.
  timeout: 60_000,
  reporter: process.env.CI ? 'github' : 'html',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js dev --port 5174',
    port: 5174,
    reuseExistingServer: !process.env.CI,
  },
})
