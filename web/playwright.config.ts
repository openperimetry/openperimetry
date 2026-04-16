import { defineConfig } from '@playwright/test'

const host = '127.0.0.1'
const port = 5174
const baseURL = `http://${host}:${port}`
const vite = 'node node_modules/vite/bin/vite.js'
const isCI = !!process.env.CI
const webServerEnv = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
)
webServerEnv.VITE_APP_URL = baseURL
webServerEnv.VITE_APP_NAME = 'Visual Field Check'
webServerEnv.VITE_SHOW_ABOUT_PAGE = 'true'

export default defineConfig({
  testDir: './e2e',
  // Keep broken CI runs bounded. Individual tests still have a focused
  // timeout below; this catches suite-level stalls such as a wedged server.
  globalTimeout: isCI ? 15 * 60_000 : undefined,
  // Run test files in parallel with multiple workers. Previously CI used a
  // single worker which serialised everything and pushed total e2e time
  // over 10 minutes. GitHub-hosted runners have 4 cores; 2 workers is a
  // safe default that halves the wall time without oversubscribing.
  fullyParallel: true,
  forbidOnly: isCI,
  // Single retry catches genuine flakes without tripling the budget.
  retries: isCI ? 1 : 0,
  workers: isCI ? 2 : undefined,
  // Timeout per test. Goldmann tests that walk through the reaction-time
  // calibration legitimately need ~45 s each; the default 30 s was firing
  // on CI under load and producing noise in the summary. Bumping to 60 s
  // gives headroom without hiding real stalls.
  timeout: 60_000,
  reporter: isCI ? 'github' : 'html',
  use: {
    baseURL,
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
    // CI runs after `npm run build`, so serve the static production build
    // instead of keeping a dev/HMR server alive. Use an explicit IPv4 host so
    // Playwright, Vite, and Chromium do not disagree between localhost/::1.
    command: isCI
      ? `${vite} preview --host ${host} --port ${port}`
      : `${vite} dev --host ${host} --port ${port}`,
    url: baseURL,
    timeout: 60_000,
    reuseExistingServer: !isCI,
    env: webServerEnv,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
})
