import { test, expect } from './fixtures/base'
import { createTestResult } from './fixtures/test-data'

test.describe('Home Page', () => {
  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    await page.goto('/')
  })

  test('displays app title and description', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Goldmann')
    await expect(page.getByText('Kinetic perimetry self-check')).toBeVisible()
  })

  test('shows three eye selection radios with proper labels', async ({ page }) => {
    await expect(page.getByRole('radio', { name: 'Left eye (OS)' })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Both eyes (OU)' })).toBeVisible()
    await expect(page.getByRole('radio', { name: 'Right eye (OD)' })).toBeVisible()
  })

  test('shows the primary Start test button', async ({ page }) => {
    await expect(page.getByRole('button', { name: /^Start test/ })).toBeVisible()
  })

  test('has test mode tablist with Goldmann selected by default', async ({ page }) => {
    const tablist = page.getByRole('tablist', { name: 'Test mode' })
    await expect(tablist).toBeVisible()
    const goldmannTab = page.getByRole('tab', { name: 'Goldmann' })
    await expect(goldmannTab).toHaveAttribute('aria-selected', 'true')
  })

  test('switching test mode updates selected tab', async ({ page }) => {
    await page.getByRole('tab', { name: 'Ring' }).click()
    await expect(page.getByRole('tab', { name: 'Ring' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('tab', { name: 'Goldmann' })).toHaveAttribute('aria-selected', 'false')
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Ring')
  })

  test('shows history button when results exist', async ({ page, seedResults }) => {
    await seedResults([createTestResult()])
    await page.goto('/')
    await expect(page.getByRole('button', { name: /Results/ })).toBeVisible()
  })

  test('hides history button when no results', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Results/ })).not.toBeVisible()
  })

  test('shows sign-in button when not authenticated', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Sign in/ })).toBeVisible()
  })

  test('has site navigation with all links', async ({ page }) => {
    const nav = page.getByRole('navigation', { name: 'Site navigation' })
    await expect(nav).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Demos' })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'References' })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'About' })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Contact' })).toBeVisible()
    await expect(nav.getByRole('button', { name: 'Privacy' })).toBeVisible()
  })

  test('has main landmark', async ({ page }) => {
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('displays clinical abbreviations with abbr elements', async ({ page }) => {
    const osAbbr = page.locator('abbr[title="Oculus Sinister"]')
    await expect(osAbbr).toBeVisible()
    const odAbbr = page.locator('abbr[title="Oculus Dexter"]')
    await expect(odAbbr).toBeVisible()
  })
})
