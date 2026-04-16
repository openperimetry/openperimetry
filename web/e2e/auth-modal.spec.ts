import { test, expect } from './fixtures/base'

test.describe('Auth Modal', () => {
  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    await page.goto('/')
    await page.getByRole('button', { name: /Sign in/ }).click()
  })

  test('opens as a dialog with proper ARIA', async ({ page }) => {
    const dialog = page.getByRole('dialog', { name: 'Sign in' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  test('shows login form with labeled inputs', async ({ page }) => {
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Password' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Sign in' }).last()).toBeVisible()
  })

  test('closes on escape key', async ({ page }) => {
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('close button has accessible label', async ({ page }) => {
    const closeBtn = page.getByRole('button', { name: 'Close dialog' })
    await expect(closeBtn).toBeVisible()
    await closeBtn.click()
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('switches to register mode', async ({ page }) => {
    await page.getByRole('button', { name: 'Create one' }).click()
    await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: /Display name/ })).toBeVisible()
  })

  test('switches to forgot password mode', async ({ page }) => {
    await page.getByRole('button', { name: 'Forgot password?' }).click()
    await expect(page.getByRole('heading', { name: 'Reset password' })).toBeVisible()
    // Only email field visible
    await expect(page.getByRole('textbox', { name: 'Email' })).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Password' })).not.toBeVisible()
  })

  test('shows error on failed login', async ({ page }) => {
    await page.route('**/api/auth/login', route =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"Invalid email or password"}' })
    )
    await page.getByRole('textbox', { name: 'Email' }).fill('test@test.com')
    await page.getByRole('textbox', { name: 'Password' }).fill('wrongpass')
    await page.getByRole('button', { name: 'Sign in' }).last().click()
    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible()
    await expect(alert).toContainText('Invalid email or password')
  })

  test('shows loading state during submission', async ({ page }) => {
    await page.route('**/api/auth/login', route =>
      new Promise(resolve => setTimeout(() => resolve(route.fulfill({
        status: 401, contentType: 'application/json', body: '{"error":"fail"}'
      })), 1000))
    )
    await page.getByRole('textbox', { name: 'Email' }).fill('test@test.com')
    await page.getByRole('textbox', { name: 'Password' }).fill('password123')
    await page.getByRole('button', { name: 'Sign in' }).last().click()
    await expect(page.getByRole('button', { name: /Signing in/ })).toBeVisible()
  })

  test('traps focus inside dialog', async ({ page }) => {
    // Focus should be inside the dialog
    const dialog = page.getByRole('dialog')
    // Tab through all elements — focus should stay inside
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab')
      await expect(dialog.locator(':focus')).toBeVisible()
    }
  })
})
