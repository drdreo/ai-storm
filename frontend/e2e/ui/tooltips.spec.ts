import { test, expect } from "../fixtures/shell";

/**
 * Tooltips (#84, audit a11y work). Radix tooltips render on hover/focus into a
 * `role="tooltip"` node. Backend-free: the control hub's session-setup controls
 * exist before any session starts.
 */
test.describe("tooltips", () => {
  test("facilitation mode trigger shows an accessible tooltip on hover", async ({ shell, page }) => {
    await shell.goto();

    // The facilitation-mode picker carries a chevron-down glyph and lives in the
    // control hub (right pane <aside>), distinct from the sidebar's Projects
    // collapsible trigger which also has a chevron.
    const modeButton = page.locator("aside button:has(svg.lucide-chevron-down)").first();
    await modeButton.hover();

    await expect(page.getByRole("tooltip")).toContainText(/Facilitation mode/i);
  });

  test("session setup advertises that settings apply on start", async ({ shell, page }) => {
    await shell.goto();
    await expect(page.getByText(/applied on start/i)).toBeVisible();
  });

  test("project status badge explains the status on hover", async ({ shell, page }) => {
    await shell.goto();

    // Collapse the sidebar so the tooltip is visible (it's only shown in collapsed state).
    // Once collapsed, the per-row "Manage" kebab is hidden (icon-only rail), so
    // `shell.projectRows` (which filters on that kebab) no longer matches —
    // scope to the Projects group's own container instead.
    await page.locator('[data-slot="sidebar-trigger"]').click();
    await expect(page.locator('[data-slot="sidebar"][data-state="collapsed"]')).toBeVisible({ timeout: 5000 });

    const badge = page.locator('[data-sidebar="content"] [data-sidebar="menu-button"]').first();
    await badge.hover({ timeout: 5000 });

    // For idle status, only show project name (no redundant "No session running" text)
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toContainText(/Untitled|Project/);
    await expect(tooltip).not.toContainText("No session running");
  });
});
