import { test, expect } from '../fixtures/shell'

/**
 * Backend-free shell structure (#84) — carries over the boot / three-pane /
 * tldraw / workspace-CRUD / IndexedDB coverage from the old `smoke.mjs`. None of
 * this needs the PTY backend: the app boots, restores workspaces, and persists
 * with the backend closed.
 */
test.describe('shell', () => {
  test('boots and renders the three panes', async ({ shell, page }) => {
    await shell.goto()

    await expect(shell.workspaceRows.first()).toBeVisible()
    await expect(shell.canvas).toBeVisible()
    // Control hub (right pane) — the harness session control.
    await expect(page.getByText('harness')).toBeVisible()
  })

  test('creates and inline-renames a workspace', async ({ shell }) => {
    await shell.goto()

    await shell.createWorkspace()
    const newRow = shell.workspaceRows.last()
    await shell.renameWorkspace(newRow, 'Untitled Project', 'QA Renamed')
  })

  test('hot-switch activates the selected workspace', async ({ shell }) => {
    await shell.goto()
    await shell.createWorkspace()

    const first = shell.workspaceRows.first()
    const last = shell.workspaceRows.last()

    await first.locator('[data-sidebar="menu-button"]').click()
    await expect(first.locator('[data-sidebar="menu-button"]')).toHaveAttribute('data-active', 'true')

    await last.locator('[data-sidebar="menu-button"]').click()
    await expect(last.locator('[data-sidebar="menu-button"]')).toHaveAttribute('data-active', 'true')
  })

  test('persists workspaces with the pinned IndexedDB name scheme', async ({ shell }) => {
    await shell.goto()
    // Touch the canvas store by ensuring at least one workspace's board exists.
    await expect.poll(() => shell.indexedDbNames()).toContain('ai-storm-registry')

    const names = await shell.indexedDbNames()
    expect(names.some((n) => n.startsWith('TLDRAW_DOCUMENT_v2ai-storm:ws:'))).toBe(true)
  })

  test('logs no unexpected console errors on boot', async ({ shell, consoleErrors }) => {
    await shell.goto()
    expect(consoleErrors).toEqual([])
  })
})
