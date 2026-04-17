import { test, expect } from './fixtures/base'

test.describe('Calibration Flow', () => {
  test.beforeEach(async ({ page, mockAPI }) => {
    await mockAPI()
    await page.goto('/')
  })

  test('clicking eye button navigates to calibration step 1', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await expect(page).toHaveTitle('Calibration — Visual Field Check')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Screen calibration')
    await expect(page.getByText('Step 1 of')).toBeVisible()
    await expect(page.getByRole('main')).toBeVisible()
  })

  test('card width slider has accessible label', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    const slider = page.getByRole('slider', { name: /Bank card width/ })
    await expect(slider).toBeVisible()
  })

  test('distance buttons have accessible labels and work', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    const decreaseBtn = page.getByRole('button', { name: 'Decrease viewing distance' })
    const increaseBtn = page.getByRole('button', { name: 'Increase viewing distance' })
    await expect(decreaseBtn).toBeVisible()
    await expect(increaseBtn).toBeVisible()
    // Initial distance is computed from the current screen size; verify the
    // controls update the displayed value without relying on a fixed monitor.
    const distanceValue = page.locator('[aria-live="polite"]')
    const initialDistance = (await distanceValue.textContent()) ?? ''
    const initialCm = Number(initialDistance.replace(/\D/g, ''))
    await (initialCm >= 100 ? decreaseBtn : increaseBtn).click()
    await expect(distanceValue).not.toHaveText(initialDistance)
  })

  test('navigates through calibration steps', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    // Step 1 → Step 2
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Brightness calibration')
    await expect(page.getByText('Step 2 of')).toBeVisible()

    // Step 2 → Step 3 (skipped for ring/static, so test with Goldmann)
    await page.getByRole('button', { name: /Confirm/ }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Reaction time test')
    await expect(page.getByText('Step 3 of')).toBeVisible()
  })

  test('back button returns to previous step', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByText('Step 2 of')).toBeVisible()
    await page.getByRole('button', { name: 'Back' }).click()
    await expect(page.getByText('Step 1 of')).toBeVisible()
  })

  test('extended field toggle has switch role', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    const toggle = page.getByRole('switch')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-checked', 'true')
  })

  test('static test skips reaction time step', async ({ page }) => {
    await page.getByRole('tab', { name: 'Static' }).click()
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    // Should be brightness
    await expect(page.getByText('Step 2 of')).toBeVisible()
    await page.getByRole('button', { name: /Confirm/ }).click()
    // Should skip to Ready, not reaction time
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ready to test')
  })

  test('advanced settings panel persists cadence across reload', async ({ page }) => {
    // Panel lives on the screen-calibration step (step 1), below the
    // field-coverage preview — no need to walk all the way to Ready.
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Screen calibration')

    // Open the disclosure and change catch-trial cadence to 5.
    await page.getByRole('button', { name: /Advanced test settings/ }).click()
    await page.getByLabel(/Catch-trial cadence/).fill('5')

    // localStorage should now hold the override.
    const stored = await page.evaluate(() => localStorage.getItem('vfc-advanced-settings'))
    expect(stored).toBeTruthy()
    expect(JSON.parse(stored!)).toMatchObject({ catchTrialEveryN: 5 })

    // Reload and navigate back to step 1 — the override should survive.
    await page.reload()
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await page.getByRole('button', { name: /Advanced test settings/ }).click()
    await expect(page.getByLabel(/Catch-trial cadence/)).toHaveValue('5')
  })

  test('Export settings button downloads a versioned JSON file', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await page.getByRole('button', { name: /Advanced test settings/ }).click()
    // Non-default cadence so the exported file carries something.
    await page.getByLabel(/Catch-trial cadence/).fill('7')

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Export settings' }).click()
    const download = await downloadPromise

    expect(download.suggestedFilename()).toMatch(/^vfc-settings_\d{4}-\d{2}-\d{2}\.json$/)

    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    const doc = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
    expect(doc.vfcSettingsVersion).toMatch(/^1\./)
    expect(typeof doc.generatedAt).toBe('string')
    // The export carries every setting — not just the override — so the
    // file doubles as a discoverable schema.
    expect(Object.keys(doc.settings).sort()).toEqual(
      ['backgroundShade', 'catchTrialEveryN', 'fixationAlertMessage', 'fixationAlertMs', 'speedPreset'],
    )
    expect(doc.settings).toMatchObject({ catchTrialEveryN: 7 })
  })

  test('Import settings applies a valid JSON file', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await page.getByRole('button', { name: /Advanced test settings/ }).click()

    const imported = {
      vfcSettingsVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      settings: { catchTrialEveryN: 17, backgroundShade: 'light' },
    }
    await page
      .getByLabel('Import settings JSON file')
      .setInputFiles({
        name: 'vfc-settings.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify(imported)),
      })

    await expect(page.getByText('Settings imported.')).toBeVisible()
    await expect(page.getByLabel(/Catch-trial cadence/)).toHaveValue('17')
    const shade = page.getByRole('radio', { name: 'light' })
    await expect(shade).toBeChecked()
  })

  test('Import settings shows an error for malformed JSON', async ({ page }) => {
    await page.getByRole('radio', { name: 'Right eye (OD)' }).click()
    await page.getByRole('button', { name: /^Start test/ }).click()
    await page.getByRole('button', { name: /Advanced test settings/ }).click()

    await page
      .getByLabel('Import settings JSON file')
      .setInputFiles({
        name: 'bad.json',
        mimeType: 'application/json',
        buffer: Buffer.from('{not json'),
      })

    await expect(page.getByRole('alert')).toContainText(/Import failed/i)
    // Cadence should not have changed from its default.
    await expect(page.getByLabel(/Catch-trial cadence/)).toHaveValue('10')
  })
})
