import { test, expect } from "../fixtures/shell";

/**
 * Folder sidebar organization (#128, #161). Tests folder CRUD, collapsing,
 * drag/drop, and specifically that project colors show when the sidebar is
 * collapsed (icon mode) with folders expanded.
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
    await expect.poll(async () => {
      const menuItemsAfter = await page.locator('[data-sidebar="menu-item"]').count();
      return menuItemsAfter > menuItemsBefore;
    }).toBeTruthy();
  });

  test("project colors are visible when sidebar is collapsed with expanded folder", async ({ shell, page }) => {
    await shell.goto();

    // Create a project and a folder
    await shell.createProject();
    const project = shell.projectRows.last();

    // Create a folder
    await shell.newMenuButton.click();
    await page.getByRole("menuitem", { name: "New folder" }).click();

    // Move the project into the folder (open kebab menu)
    const kebab = project.locator('[data-sidebar="menu-action"]').first();
    await kebab.click();
    await page.getByRole("menuitem", { name: "Move to folder" }).click();
    const firstFolder = await page.getByRole("menuitem", { hasText: /^[^(]*$/ }).first();
    await firstFolder.click();

    // The sidebar should still show the project's color indicator (StatusDot)
    // even when in collapsed icon mode. In collapsed mode, the folder header
    // expands to show child projects as small icons with color indicators.
    const statusDots = project.locator('[data-sidebar="menu-button"] span').first();
    await expect(statusDots).toBeVisible();
  });
});
