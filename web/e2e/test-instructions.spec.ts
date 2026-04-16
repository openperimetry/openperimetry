import { test, expect } from './fixtures/base'

test.describe('Test Instructions', () => {
  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    await page.goto('/')
    // Navigate through calibration quickly using static test (skips RT)
    await page.getByRole('tab', { name: 'Static' }).click()
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: /Confirm/ }).click()
    // Now on Ready screen
    await page.getByRole('button', { name: 'Start test' }).click()
  })

  test('shows instructions with correct eye', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Right/)
  })

  test('shows stimulus levels', async ({ page }) => {
    await expect(page.getByText('V4e')).toBeVisible()
    await expect(page.getByText('III4e')).toBeVisible()
  })

  test('has cancel button to return home', async ({ page }) => {
    await page.getByRole('button', { name: /Cancel/i }).click()
    await expect(page).toHaveTitle('Visual Field Check — Free Self-Test for RP')
  })
})
