import { test, expect } from '../fixtures/shell'

/**
 * Dialogs (#84). Covers the themed delete-confirm dialog (audit H5) and the
 * modal-over-tldraw z-index bug (#82) — the regression that previously only
 * surfaced by manual report. A modal that renders behind tldraw's canvas is the
 * exact failure these assert against.
 */
test.describe('dialogs', () => {
  test('settings dialog renders above the tldraw canvas', async ({ shell, page }) => {
    await shell.goto()
    const dialog = await shell.openSettings()

    // The bug (#82): app modals slipping under tldraw's stacking layer. A
    // visible, interactable control inside the dialog proves it's on top.
    const darkRadio = dialog
      .getByRole('radiogroup', { name: 'Appearance' })
      .getByRole('radio', { name: 'Dark' })
    await expect(darkRadio).toBeVisible()
    await darkRadio.click() // would throw "intercepted" if the canvas covered it
    await expect(page.locator('html')).toHaveClass(/dark/)
  })

  test('settings dialog closes on Escape', async ({ shell, page }) => {
    await shell.goto()
    await shell.openSettings()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('delete confirm requires explicit confirmation', async ({ shell, page }) => {
    await shell.goto()
    await shell.createWorkspace()
    const before = await shell.workspaceRows.count()
    const target = shell.workspaceRows.last()

    await target.getByRole('button', { name: /^Manage / }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Delete workspace?' })).toBeVisible()

    // Cancel leaves the workspace intact (no destructive window.confirm path).
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(shell.workspaceRows).toHaveCount(before)

    // Re-open and confirm — only an explicit "Delete workspace" removes it.
    await target.getByRole('button', { name: /^Manage / }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete workspace' }).click()
    await expect(shell.workspaceRows).toHaveCount(before - 1)
  })
})
