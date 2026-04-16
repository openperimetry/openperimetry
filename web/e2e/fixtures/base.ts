import { test as base } from '@playwright/test'
import type { TestResult } from '../../src/types'

export const test = base.extend<{
  mockAPI: () => Promise<void>
  seedResults: (results: TestResult[]) => Promise<void>
}>({
  mockAPI: async ({ page }, use) => {
    const mock = async () => {
      // Mock auth check to prevent 502s — return unauthenticated
      await page.route('**/api/auth/me', route =>
        route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Not authenticated"}' })
      )
      // Mock sync endpoint
      await page.route('**/api/users/me/vf-results/sync', route =>
        route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Not authenticated"}' })
      )
      // Mock survey endpoint
      await page.route('**/api/vf-surveys', route =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
      )
    }
    await use(mock)
  },

  seedResults: async ({ page }, use) => {
    const seed = async (results: TestResult[]) => {
      await page.addInitScript((data) => {
        localStorage.setItem('goldmann-vf-results', JSON.stringify(data))
      }, results)
    }
    await use(seed)
  },
})

export { expect } from '@playwright/test'
