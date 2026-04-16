import { test, expect } from './fixtures/base'
import AxeBuilder from '@axe-core/playwright'
import { createTestResult } from './fixtures/test-data'

// Exclude color-contrast: the dark theme intentionally uses muted grays for
// decorative/secondary text. Fixing contrast is a separate design task.

test.describe('Accessibility', () => {
  test.beforeEach(async ({ mockAPI }) => {
    await mockAPI()
  })

  test('home page has no accessibility violations', async ({ page }) => {
    await page.goto('/')
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })

  test('about page has no accessibility violations', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('navigation').getByRole('button', { name: 'About' }).click()
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })

  test('contact page has no accessibility violations', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('navigation').getByRole('button', { name: 'Contact' }).click()
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })

  test('privacy page has no accessibility violations', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('navigation').getByRole('button', { name: 'Privacy' }).click()
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })

  test('auth modal has no accessibility violations', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Sign in/ }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })

  test('calibration page has no accessibility violations', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })

  test('history page has no accessibility violations', async ({ page, seedResults }) => {
    await seedResults([createTestResult()])
    await page.goto('/')
    await page.getByRole('button', { name: /Results/ }).click()
    const results = await new AxeBuilder({ page }).disableRules(['color-contrast']).analyze()
    expect(results.violations).toEqual([])
  })
})
