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
      const records = results.map(result => ({
        id: result.id,
        eye: result.eye,
        date: result.date,
        data: JSON.stringify(result),
      }))

      await page.unroute('**/api/auth/me').catch(() => {})
      await page.unroute('**/api/users/me/vf-results').catch(() => {})
      await page.unroute('**/api/users/me/vf-results/sync').catch(() => {})

      await page.route('**/api/auth/me', route =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            user: {
              id: 'e2e-user',
              email: 'e2e@example.com',
              displayName: 'E2E User',
            },
          }),
        })
      )
      await page.route('**/api/users/me/vf-results', route =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ results: records }),
        })
      )
      await page.route('**/api/users/me/vf-results/sync', route =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ results: records, added: records.length }),
        })
      )

      await page.addInitScript((data) => {
        localStorage.setItem('goldmann-vf-results', JSON.stringify(data))
      }, results)
    }
    await use(seed)
  },
})

export { expect } from '@playwright/test'
