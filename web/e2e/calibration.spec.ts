import { test, expect } from './fixtures/base'

test.describe('Calibration Flow', () => {
  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    await page.goto('/')
  })

  test('clicking eye button navigates to calibration step 1', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await expect(page).toHaveTitle('Calibration — Visual Field Check')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Screen calibration')
    await expect(page.getByText('Step 1 of')).toBeVisible()
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('card width slider has accessible label', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    const slider = page.getByRole('slider', { name: /Bank card width/ })
    await expect(slider).toBeVisible()
  })

  test('distance buttons have accessible labels and work', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    const decreaseBtn = page.getByRole('button', { name: 'Decrease viewing distance' })
    const increaseBtn = page.getByRole('button', { name: 'Increase viewing distance' })
    await expect(decreaseBtn).toBeVisible()
    await expect(increaseBtn).toBeVisible()
    // Check initial distance
    await expect(page.getByText('50 cm').first()).toBeVisible()
    await decreaseBtn.click()
    await expect(page.getByText('45 cm').first()).toBeVisible()
  })

  test('navigates through calibration steps', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    // Step 1 → Step 2
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Brightness calibration')
    await expect(page.getByText('Step 2 of')).toBeVisible()

    // Step 2 → Step 3 (skipped for ring/static, so test with Goldmann)
    await page.getByRole('button', { name: /Confirm/ }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reaction time test')
    await expect(page.getByText('Step 3 of')).toBeVisible()
  })

  test('back button returns to previous step', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByText('Step 2 of')).toBeVisible()
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByText('Step 1 of')).toBeVisible()
  })

  test('extended field toggle has switch role', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    const toggle = page.getByRole('switch')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  test('static test skips reaction time step', async ({ page }) => {
    await page.getByRole('tab', { name: 'Static' }).click()
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    // Should be brightness
    await expect(page.getByText('Step 2 of')).toBeVisible()
    await page.getByRole('button', { name: /Confirm/ }).click()
    // Should skip to Ready, not reaction time
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ready to test')
  })
})
