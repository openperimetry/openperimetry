import { test, expect } from './fixtures/base'

test.describe('Static Pages', () => {
  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    await page.goto('/')
  })

  test('About page shows author info and images', async ({ page }) => {
    await page.getByRole('navigation').getByRole('button', { name: 'About' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('About')
    await expect(page.getByText('Daniël Tom')).toBeVisible()
    // Images have alt text
    const images = page.getByRole('img')
    const count = await images.count()
    for (let i = 0; i < count; i++) {
      const alt = await images.nth(i).getAttribute('alt')
      expect(alt).toBeTruthy()
    }
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
})
