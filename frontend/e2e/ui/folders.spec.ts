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

  test("folders are fixed disclosures and never reorder", async ({ shell, page }) => {
    await shell.goto();

    await shell.createFolder("Alpha");
    await shell.createFolder("Beta");

    const alpha = shell.folderRows.filter({ hasText: "Alpha" });
    const disclosure = alpha.locator('[data-sidebar="menu-button"]').first();
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-sidebar="folder-drag-handle"]')).toHaveCount(0);

    // A little pointer motion is normal during a click. It exceeds dnd-kit's
    // project-drag threshold deliberately: a folder label must still behave
    // only as a disclosure.
    const box = await disclosure.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 2, y + 8, { steps: 2 });
    await page.mouse.up();

    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
    await expect(shell.folderRows.locator('[data-sidebar="menu-button"]')).toHaveText([/Alpha/, /Beta/]);
  });

  test("drags a project back to the empty top level", async ({ shell, page }) => {
    await shell.goto();

    const project = shell.projectRows.first();
    await shell.createFolder("Group");
    const folder = shell.folderRows.filter({ hasText: "Group" });

    await project.locator('[data-sidebar="menu-action"]').first().click();
    await page.getByRole("menuitem", { name: "Move to folder" }).click();
    await page.getByRole("menuitem", { name: "Group", exact: true }).click();
    await expect(folder.locator(".group\\/ws-row")).toHaveCount(1);

    const source = await folder.locator(".group\\/ws-row").boundingBox();
    expect(source).not.toBeNull();
    await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2);
    await page.mouse.down();
    await page.mouse.move(source!.x + source!.width / 2, source!.y + source!.height / 2 + 8, { steps: 2 });

    const dropZone = page.getByText("Drop here to ungroup", { exact: true });
    await expect(dropZone).toBeVisible();
    const target = await dropZone.boundingBox();
    expect(target).not.toBeNull();
    await page.mouse.move(target!.x + target!.width / 2, target!.y + target!.height / 2, { steps: 5 });
    await page.mouse.up();

    await expect(folder.locator(".group\\/ws-row")).toHaveCount(0);
    await expect(shell.projectRows).toHaveCount(1);
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
