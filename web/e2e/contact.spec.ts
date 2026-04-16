import { test, expect } from './fixtures/base'

test.describe('Contact Page', () => {
  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    await page.goto('/')
    await page.getByRole('navigation').getByRole('button', { name: 'Contact' }).click()
  })

  test('shows contact form with labeled fields', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Contact')
    await expect(page.getByLabel('Name')).toBeVisible()
    await expect(page.getByLabel('Email')).toBeVisible()
    await expect(page.getByLabel('Message')).toBeVisible()
  })

  test('submits successfully with mocked API', async ({ page }) => {
    await page.route('**/api/contact', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    )
    await page.getByLabel('Name').fill('Test User')
    await page.getByLabel('Email').fill('test@example.com')
    await page.getByLabel('Message').fill('Great app!')
    await page.getByRole('button', { name: /Send|Submit/ }).click()
    await expect(page.getByText('Message sent!')).toBeVisible()
  })

  test('shows error on failed submission', async ({ page }) => {
    await page.route('**/api/contact', route =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"Server error"}' })
    )
    await page.getByLabel('Name').fill('Test User')
    await page.getByLabel('Email').fill('test@example.com')
    await page.getByLabel('Message').fill('Test message')
    await page.getByRole('button', { name: /Send|Submit/ }).click()
    await expect(page.getByText('Server error')).toBeVisible()
  })
})
