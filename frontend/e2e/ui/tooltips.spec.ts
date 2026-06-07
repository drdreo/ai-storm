import { test, expect } from '../fixtures/shell'

/**
 * Tooltips (#84, audit a11y work). Radix tooltips render on hover/focus into a
 * `role="tooltip"` node. Backend-free: the control hub's session-setup controls
 * exist before any session starts.
 */
test.describe('tooltips', () => {
  test('facilitation mode trigger shows an accessible tooltip on hover', async ({ shell, page }) => {
    await shell.goto()

    // The facilitation-mode picker carries a chevron-down glyph and lives in the
    // control hub (right pane <aside>), distinct from the sidebar's Workspaces
    // collapsible trigger which also has a chevron.
    const modeButton = page.locator('aside button:has(svg.lucide-chevron-down)').first()
    await modeButton.hover()

    await expect(page.getByRole('tooltip')).toContainText(/Facilitation mode/i)
  })

  test('session setup advertises that settings apply on start', async ({ shell, page }) => {
    await shell.goto()
    await expect(page.getByText(/applied on start/i)).toBeVisible()
  })
})
