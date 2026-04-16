import { test, expect } from './fixtures/base'

test.describe('Mobile Viewport', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    hasTouch: true,
  })

  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    // Override maxTouchPoints for mobile detection
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, writable: false })
    })
    await page.goto('/')
  })

  test('shows mobile mode toggle on mobile devices', async ({ page }) => {
    const toggle = page.getByRole('switch', { name: /phone mode/i })
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  })

  test('activating mobile mode shows phone mode info', async ({ page }) => {
    const toggle = page.getByRole('switch', { name: /phone mode/i })
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByText('Phone mode').first()).toBeVisible()
    await expect(page.getByText(/landscape/i)).toBeVisible()
  })

  test('mobile mode forces static test', async ({ page }) => {
    await page.getByRole('switch', { name: /phone mode/i }).click()
    // Static tab should be selected after enabling mobile mode
    await expect(page.getByRole('tab', { name: 'Static' })).toHaveAttribute('aria-selected', 'true')
  })

  test('app is usable at mobile viewport', async ({ page }) => {
    // All main elements should be visible and not overflowing
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Left eye (OS)' })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Right eye (OD)' })).toBeVisible()
  })
})
