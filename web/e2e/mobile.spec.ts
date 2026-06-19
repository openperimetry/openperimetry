import { test, expect } from './fixtures/base'

test.describe('Phone support', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    hasTouch: true,
  })

  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    // Override maxTouchPoints so the phone-like device branch is exercised.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, writable: false })
    })
    await page.goto('/')
  })

  test('does not show deprecated phone warnings', async ({ page }) => {
    await expect(page.getByText(/designed for larger screens/i)).toHaveCount(0)
    await expect(page.getByText(/mobile device detected/i)).toHaveCount(0)
    await expect(page.getByText(/use a laptop, desktop monitor, or tablet/i)).toHaveCount(0)
  })

  test('home screen still renders the primary controls on a small viewport', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Left eye (OS)' })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Right eye (OD)' })).toBeVisible()
  })

  test('Phone VR presentation option is selectable on a phone', async ({ page }) => {
    const phoneVr = page.getByRole('radio', { name: 'Phone VR' })
    await expect(phoneVr).toBeVisible()
    await expect(phoneVr).toBeEnabled()
    await phoneVr.click()
    await expect(phoneVr).toHaveAttribute('aria-checked', 'true')
    // The "requires a phone" caption is hidden once the option is usable.
    await expect(page.getByText(/Phone VR requires a phone in a headset/i)).toHaveCount(0)
  })
})

test.describe('Phone VR on a non-phone device', () => {
  // Default desktop viewport + UA: isPhoneLikeDevice() is false, so the whole
  // presentation control is hidden — Phone VR needs a phone in a headset.
  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    await page.goto('/')
  })

  test('Phone VR option is hidden on desktop', async ({ page }) => {
    await expect(page.getByRole('radio', { name: 'Phone VR' })).toHaveCount(0)
    await expect(page.getByText(/^Presentation$/i)).toHaveCount(0)
  })
})
