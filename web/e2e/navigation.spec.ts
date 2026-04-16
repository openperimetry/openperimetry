import { test, expect } from './fixtures/base'

const homeTitle = 'Visual Field Check — Free visual field self-test'

test.describe('Page Navigation', () => {
  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    await page.goto('/')
  })

  const navPages = [
    { button: 'About', title: 'About — Visual Field Check', heading: 'About' },
    { button: 'Contact', title: 'Contact — Visual Field Check', heading: 'Contact' },
    { button: 'Privacy', title: 'Privacy Policy — Visual Field Check', heading: 'Privacy Policy' },
    { button: 'References', title: 'Scientific References — Visual Field Check', heading: 'Scientific References' },
    { button: 'Demos', title: 'Clinical Demos — Visual Field Check', heading: 'Clinical Scenario Demo' },
  ]

  for (const { button, title, heading } of navPages) {
    test(`navigates to ${button} and back`, async ({ page }) => {
      // Demos renders many heavy VisionSimulator canvases — give it more time.
      if (button === 'Demos') test.slow()

      await page.getByRole('navigation').getByRole('button', { name: button }).click()
      await expect(page).toHaveTitle(title)
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading)
      await expect(page.getByRole('main')).toBeVisible()

      // Navigate back
      await page.getByRole('button', { name: /Back|Home/ }).click()
      await expect(page).toHaveTitle(homeTitle)
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Goldmann')
    })
  }

  test('document title updates on page change', async ({ page }) => {
    await expect(page).toHaveTitle(homeTitle)
    await page.getByRole('navigation').getByRole('button', { name: 'About' }).click()
    await expect(page).toHaveTitle('About — Visual Field Check')
  })
})
