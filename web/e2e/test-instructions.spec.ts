import { test, expect } from './fixtures/base'

const homeTitle = 'Visual Field Check — Free visual field self-test'

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

  test('shows static test options', async ({ page }) => {
    await expect(page.getByText('100 hexagons', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: /Standard 100 pts/ })).toBeVisible()
  })

  test('has cancel button to return home', async ({ page }) => {
    await page.getByRole('button', { name: /Cancel/i }).click()
    await expect(page).toHaveTitle(homeTitle)
  })
})
