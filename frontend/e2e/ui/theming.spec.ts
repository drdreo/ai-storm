import { test, expect } from '../fixtures/shell'

/**
 * Theming (#84, covering the #77–#83 audit gap). The 5-knob appearance system
 * reflects each choice onto `<html>` data-attributes + the `.dark` class. These
 * assert the DOM contract the CSS keys off — the regression surface that the
 * node-env unit suite structurally cannot see.
 */
test.describe('appearance settings', () => {
  test('dark mode toggles the .dark class and persists', async ({ shell, page }) => {
    await shell.goto()
    const dialog = await shell.openSettings()

    await dialog.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Dark' }).click()
    await expect(page.locator('html')).toHaveClass(/dark/)

    await page.reload()
    // Re-applied before first paint by index.html's boot script (no flash).
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('light mode removes the .dark class', async ({ shell, page }) => {
    await shell.goto()
    const dialog = await shell.openSettings()

    await dialog.getByRole('radiogroup', { name: 'Appearance' }).getByRole('radio', { name: 'Light' }).click()
    await expect(page.locator('html')).not.toHaveClass(/dark/)
  })

  test('each appearance knob writes its <html> data-attribute', async ({ shell, page }) => {
    await shell.goto()
    const dialog = await shell.openSettings()
    const html = page.locator('html')

    await dialog.getByRole('radiogroup', { name: 'Color theme' }).getByRole('radio', { name: 'Ember' }).click()
    await expect(html).toHaveAttribute('data-theme', 'ember')

    await dialog.getByRole('radiogroup', { name: 'Font' }).getByRole('radio', { name: 'Mono' }).click()
    await expect(html).toHaveAttribute('data-font', 'mono')

    await dialog.getByRole('radiogroup', { name: 'Corners' }).getByRole('radio', { name: 'Round' }).click()
    await expect(html).toHaveAttribute('data-radius', 'round')

    await dialog.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Compact' }).click()
    await expect(html).toHaveAttribute('data-density', 'compact')

    await dialog.getByRole('radiogroup', { name: 'Contrast' }).getByRole('radio', { name: 'High' }).click()
    await expect(html).toHaveAttribute('data-contrast', 'high')
  })

  test('slate palette omits the data-theme attribute', async ({ shell, page }) => {
    await shell.goto()
    const dialog = await shell.openSettings()
    const colorTheme = dialog.getByRole('radiogroup', { name: 'Color theme' })

    await colorTheme.getByRole('radio', { name: 'Ember' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'ember')

    await colorTheme.getByRole('radio', { name: 'Slate' }).click()
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.*/)
  })
})
