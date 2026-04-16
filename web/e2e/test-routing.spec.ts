import type { Page } from '@playwright/test'
import { test, expect } from './fixtures/base'

type TestMode = 'goldmann' | 'ring' | 'static'
type EyeChoice = 'Left eye (OS)' | 'Right eye (OD)' | 'Both eyes (OU)'

// Heading shown on each test's instruction screen (binocular always starts with right eye).
const HEADINGS: Record<TestMode, RegExp> = {
  goldmann: /eye — multi-isopter$/,
  ring: /^Ring Test$/,
  static: /eye — static test$/,
}

async function selectTestMode(page: Page, mode: TestMode) {
  const tabName = mode === 'goldmann' ? 'Goldmann' : mode === 'ring' ? 'Ring' : 'Static'
  await page.getByRole('tab', { name: tabName }).click()
}

async function completeReactionTime(page: Page) {
  // Start the RT instruction screen
  await page.getByRole('heading', { name: 'Reaction time test' }).waitFor()
  await page.getByRole('button', { name: 'Start' }).click()
  // 5 trials: wait for the dot, then press Space
  for (let i = 0; i < 5; i++) {
    await page.getByText('Press Space or tap NOW!').waitFor({ timeout: 10_000 })
    await page.keyboard.press('Space')
  }
  // Summary screen → Next
  await page.getByRole('heading', { name: 'Reaction time measured' }).waitFor()
  await page.getByRole('button', { name: 'Next' }).click()
}

async function completeCalibration(page: Page, mode: TestMode) {
  // Step 1 (screen) → Next
  await page.getByRole('button', { name: 'Next' }).click()
  // Step 2 (brightness) → Confirm
  await page.getByRole('button', { name: /Confirm/ }).click()
  // Goldmann inserts a reaction-time step before Ready
  if (mode === 'goldmann') {
    await completeReactionTime(page)
  }
  // Ready → Start test
  await page.getByRole('button', { name: 'Start test' }).click()
}

async function startFlow(page: Page, mode: TestMode, eye: EyeChoice) {
  await selectTestMode(page, mode)
  // Eye buttons are radios now; pick one and then click the prominent
  // "Start test" CTA below the selectors.
  await page.getByRole('radio', { name: eye }).click()
  await page.getByRole('button', { name: /^Start test/ }).click()
  await completeCalibration(page, mode)
}

test.describe('Test routing — eye × test type', () => {
  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    await page.goto('/')
  })

  // Ring + Static are fast (no RT step)
  for (const mode of ['ring', 'static'] as const) {
    test(`${mode} × right eye → ${mode} test screen`, async ({ page }) => {
      await startFlow(page, mode, 'Right eye (OD)')
      await expect(page.getByRole('heading', { level: 1 })).toContainText(HEADINGS[mode])
    })

    test(`${mode} × left eye → ${mode} test screen`, async ({ page }) => {
      await startFlow(page, mode, 'Left eye (OS)')
      await expect(page.getByRole('heading', { level: 1 })).toContainText(HEADINGS[mode])
    })

    test(`${mode} × both eyes → ${mode} test screen (right eye first)`, async ({ page }) => {
      await startFlow(page, mode, 'Both eyes (OU)')
      const heading = page.getByRole('heading', { level: 1 })
      await expect(heading).toContainText(HEADINGS[mode])
      // Binocular flow always begins with the right eye
      if (mode === 'static') {
        await expect(heading).toContainText(/Right/)
      }
    })
  }

  // Goldmann variants — slower because of reaction-time calibration
  test('goldmann × right eye → goldmann test screen', async ({ page }) => {
    test.slow()
    await startFlow(page, 'goldmann', 'Right eye (OD)')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(HEADINGS.goldmann)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Right/)
  })

  test('goldmann × left eye → goldmann test screen', async ({ page }) => {
    test.slow()
    await startFlow(page, 'goldmann', 'Left eye (OS)')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(HEADINGS.goldmann)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Left/)
  })

  test('goldmann × both eyes → goldmann test screen (right eye first)', async ({ page }) => {
    test.slow()
    await startFlow(page, 'goldmann', 'Both eyes (OU)')
    await expect(page.getByRole('heading', { level: 1 })).toContainText(HEADINGS.goldmann)
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Right/)
  })
})
