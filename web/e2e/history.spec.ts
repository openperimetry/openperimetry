import { test, expect } from './fixtures/base'
import type { Page } from '@playwright/test'
import { createTestResult, createResultPair } from './fixtures/test-data'

test.describe('History Page', () => {
  test.beforeEach(async ({ mockAPI }) => {
    await mockAPI()
  })

  const firstResultButton = (page: Page) =>
    page.getByRole('button', { name: /O[DS] \((Right|Left)\).*deg²/ }).first()

  test('shows empty state when no results', async ({ page, seedResults }) => {
    await seedResults([])
    await page.goto('/')
    // History button should not be visible
    await expect(page.getByRole('button', { name: /Results/ })).not.toBeVisible()
  })

  test('shows results list grouped by eye', async ({ page, seedResults }) => {
    await seedResults(createResultPair())
    await page.goto('/')
    await page.getByRole('button', { name: /Results/ }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Results')
    await expect(page.getByRole('button', { name: /OD \(Right\).*deg²/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /OS \(Left\).*deg²/ })).toBeVisible()
  })

  test('shows local storage warning when not logged in', async ({ page, seedResults }) => {
    await seedResults([createTestResult()])
    await page.goto('/')
    await page.getByRole('button', { name: /Results/ }).click()
    await expect(page.getByText('Results stored locally only')).toBeVisible()
  })

  test('navigates to result detail view', async ({ page, seedResults }) => {
    await seedResults([createTestResult()])
    await page.goto('/')
    await page.getByRole('button', { name: /Results/ }).click()
    await firstResultButton(page).click()
    // Should show detail view with back button
    await expect(page.getByRole('button', { name: 'Back to results' })).toBeVisible()
    await expect(page.getByText(/deg²/).first()).toBeVisible()
  })

  test('delete shows confirmation dialog', async ({ page, seedResults }) => {
    await seedResults([createTestResult()])
    await page.goto('/')
    await page.getByRole('button', { name: /Results/ }).click()
    await firstResultButton(page).click()
    // Click delete
    await page.getByRole('button', { name: 'Delete' }).click()
    // Confirmation dialog appears
    const dialog = page.getByRole('alertdialog')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Delete result?')).toBeVisible()
    await expect(dialog.getByText('permanently remove')).toBeVisible()
  })

  test('cancel delete keeps result', async ({ page, seedResults }) => {
    await seedResults([createTestResult()])
    await page.goto('/')
    await page.getByRole('button', { name: /Results/ }).click()
    await firstResultButton(page).click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click()
    // Dialog closes, result still visible
    await expect(page.getByRole('alertdialog')).not.toBeVisible()
    await expect(page.getByText(/deg²/).first()).toBeVisible()
  })

  test('confirm delete removes result', async ({ page, seedResults }) => {
    await seedResults([createTestResult()])
    await page.goto('/')
    await page.getByRole('button', { name: /Results/ }).click()
    await firstResultButton(page).click()
    await page.getByRole('button', { name: 'Delete' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
    // Should return to history list
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Results')
    await expect(page.getByText('No results yet')).toBeVisible()
  })
})
