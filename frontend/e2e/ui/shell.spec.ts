import { test, expect } from "../fixtures/shell";

/**
 * Backend-free shell structure (#84) — boot / three-pane / tldraw /
 * project-CRUD coverage carried over from the old `smoke.mjs`. Durable state
 * is served by the fixtures' fake state backend (#233); no PTY backend runs.
 */
test.describe("shell", () => {
  test("boots and renders the three panes", async ({ shell, page }) => {
    await shell.goto();

    await expect(shell.projectRows.first()).toBeVisible();
    await expect(shell.canvas).toBeVisible();
    // Control hub (right pane) — the harness session control.
    await expect(page.getByText("harness")).toBeVisible();
  });

  test("creates and inline-renames a project", async ({ shell }) => {
    await shell.goto();

    await shell.createProject();
    const newRow = shell.projectRows.last();
    await shell.renameProject(newRow, "Untitled Project", "QA Renamed");
  });

  test("hot-switch activates the selected project", async ({ shell }) => {
    await shell.goto();
    await shell.createProject();

    const first = shell.projectRows.first();
    const last = shell.projectRows.last();

    await first.locator('[data-sidebar="menu-button"]').click();
    await expect(first.locator('[data-sidebar="menu-button"]')).toHaveAttribute("data-active", "true");

    await last.locator('[data-sidebar="menu-button"]').click();
    await expect(last.locator('[data-sidebar="menu-button"]')).toHaveAttribute("data-active", "true");
  });

  test("creates no browser IndexedDB stores — the backend owns durable state (#233)", async ({ shell }) => {
    await shell.goto();
    await shell.createProject();

    // The pre-#233 registry/board stores must never come back: a reappearing
    // `ai-storm-registry` or `TLDRAW_DOCUMENT_v2ai-storm:ws:*` database means a
    // code path started persisting boards in the browser again.
    const names = await shell.indexedDbNames();
    expect(names.filter((n) => n.includes("ai-storm") || n.startsWith("TLDRAW_DOCUMENT"))).toEqual([]);
  });

  test("logs no unexpected console errors on boot", async ({ shell, consoleErrors }) => {
    await shell.goto();
    expect(consoleErrors).toEqual([]);
  });
});
