import { test, expect } from './fixtures/base'

test.describe('Small-screen warning', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    hasTouch: true,
  })

  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    // Override maxTouchPoints so the touch-phone branch of detectSmallScreen fires
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, writable: false })
    })
    await page.goto('/')
  })

  test('shows "designed for larger screens" warning on phone viewport', async ({ page }) => {
    await expect(page.getByText(/designed for larger screens/i)).toBeVisible()
  })

  test('does not expose a phone-mode toggle anymore', async ({ page }) => {
    // The old phone-mode switch has been removed; only the warning banner
    // remains. If this ever reappears the home screen regressed.
    const toggle = page.getByRole('switch', { name: /phone mode/i })
    await expect(toggle).toHaveCount(0)
  })

  test('home screen still renders the primary controls on a small viewport', async ({ page }) => {
    // Test is informational, not a hard block — core controls must still be reachable.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Left eye (OS)' })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Right eye (OD)' })).toBeVisible()
  })
})
