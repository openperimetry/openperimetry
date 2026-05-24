import { test, expect } from './fixtures/base'

test.describe('Static Pages', () => {
  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    await page.goto('/')
  })

  test('Privacy page shows policy sections', async ({ page }) => {
    await page.getByRole('navigation').getByRole('button', { name: 'Privacy' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy Policy')
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('Science page shows references', async ({ page }) => {
    await page.getByRole('navigation').getByRole('button', { name: 'References' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Scientific References')
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('Demo page shows scenarios', async ({ page }) => {
    test.slow() // heavy VisionSimulator canvases
    await page.getByRole('navigation').getByRole('button', { name: 'Demos' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Clinical Scenario Demo')
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('methods page surfaces catch-trial, FA/FPRR, and related-tools content', async ({ page }) => {
    await page.getByRole('navigation').getByRole('button', { name: 'Methods' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Methods/i)
    // Dynamic params should surface from testDefaults.ts
    await expect(page.getByText(/catch.?trial/i).first()).toBeVisible()
    await expect(page.getByRole('cell', { name: /Fixation Accuracy/i })).toBeVisible()
    await expect(page.getByText(/79.99%/).first()).toBeVisible()
    // Related-tools table should include Specvis and Peristat
    await expect(page.getByRole('cell', { name: /Specvis Desktop/i })).toBeVisible()
    await expect(page.getByRole('cell', { name: /Peristat Online/i })).toBeVisible()
    // Honest positioning
    await expect(page.getByText(/not yet.*validated/i)).toBeVisible()
  })
})
