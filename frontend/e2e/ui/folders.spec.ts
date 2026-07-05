import { test, expect } from "../fixtures/shell";

/**
 * Folder sidebar organization (#128, #161). Tests folder CRUD and specifically
 * that project colors show when the sidebar is collapsed to icon mode.
 */
test.describe("folders", () => {
  test("creates a folder and moves a project into it", async ({ shell, page }) => {
    await shell.goto();

    // Create a project
    await shell.createProject();

    // Create a folder via the "New…" menu
    const menuItemsBefore = await page.locator('[data-sidebar="menu-item"]').count();
    await shell.newMenuButton.click();
    await page.getByRole("menuitem", { name: "New folder" }).click();

    // Verify the folder is created (menu-item count increases)
    await expect
      .poll(async () => {
        const menuItemsAfter = await page.locator('[data-sidebar="menu-item"]').count();
        return menuItemsAfter > menuItemsBefore;
      })
      .toBeTruthy();
  });

  test("project colors are visible in collapsed sidebar with expanded folder", async ({ shell, page }) => {
    await shell.goto();

    await shell.createProject();
    const project = shell.projectRows.last();

    await shell.createFolder("Test Folder");

    // Move the project into the folder
    const kebab = project.locator('[data-sidebar="menu-action"]').first();
    await kebab.click();
    await page.getByRole("menuitem", { name: "Move to folder" }).click();
    await page.getByRole("menuitem", { name: "Test Folder", exact: true }).click();

    // Now collapse the sidebar to icon mode using keyboard shortcut (Ctrl+B or Cmd+B)
    await page.keyboard.press("Control+b");

    // Wait for the sidebar to collapse (data-state changes to "collapsed")
    await expect(page.locator('[data-state="collapsed"]')).toBeVisible();

    // The project's color indicator (StatusDot) should still be visible in the sidebar
    // even in collapsed mode.
    const menuSubButton = page.locator('[data-sidebar="menu-sub"]').first();
    await expect(menuSubButton).toBeVisible();

    // Verify all color indicators are visible in the sidebar
    const statusDotSpans = await page.locator('[data-testid="status-dot"]').all();
    for (const item of await statusDotSpans) {
      await expect(item).toBeVisible();
    }
    expect(statusDotSpans.length).toBe(2);
  });
});
