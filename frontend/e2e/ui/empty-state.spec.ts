import { test, expect } from '../fixtures/shell'

/**
 * Empty states (#84, audit H2). A fresh board has zero idea cards, so the
 * canvas onboarding overlay teaches the three core moves; the control hub shows
 * its no-session hint. Both are backend-free.
 */
test.describe('empty states', () => {
  test('canvas shows the first-run onboarding overlay', async ({ shell, page }) => {
    await shell.goto()
    // Fresh workspace → no idea cards → the teaching overlay is visible.
    await shell.createWorkspace()

    await expect(page.getByRole('heading', { name: 'Start your storm' })).toBeVisible()
    await expect(page.getByText('Press to drop your first idea card')).toBeVisible()
  })

  test('control hub shows the no-session hint before start', async ({ shell, page }) => {
    await shell.goto()

    await expect(page.getByText(/No session yet/)).toBeVisible()
    await expect(shell.startSessionButton).toBeVisible()
  })

  test('control hub surfaces the offline backend and disables Start', async ({ shell, page }) => {
    await shell.goto()

    // The ui project runs without the PTY backend, so the single session
    // indicator must read offline and Start must be gated on it.
    await expect(page.getByText('backend offline')).toBeVisible()
    await expect(shell.startSessionButton).toBeDisabled()

    // Collapsing the hub keeps the indicator visible as the rail dot (#109).
    // Name is matched loosely: the backend store retries, so the offline label
    // legitimately flips between "backend offline" and "connecting".
    await page.getByRole('button', { name: 'Collapse control hub' }).click()
    await expect(page.getByRole('status', { name: /Session:/ })).toBeVisible()
    await page.getByRole('button', { name: 'Expand control hub' }).click()
    await expect(shell.startSessionButton).toBeVisible()
  })
})
