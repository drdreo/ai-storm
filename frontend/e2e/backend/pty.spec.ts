import { test, expect } from "../fixtures/shell";

/**
 * Backend-dependent PTY round-trip (#84) — the coverage that genuinely needs the
 * Node/ConPTY backend on :8787, carried over from the old `smoke.mjs`. Run
 * locally with the backend up (`pnpm dev:backend`); skipped on CI's ubuntu boxes
 * where ConPTY isn't available.
 *
 * Validates the in-browser runtime the unit/build steps can't:
 *   - a real PTY session round-trips through ConPTY (data → xterm → input)
 *   - hot-switch preserves a workspace's terminal scrollback (PRD §3.4)
 */
test.describe("PTY session", () => {
  test("round-trips terminal output and survives hot-switch", async ({ shell, page }) => {
    test.slow(); // a real shell spawn + echo takes several seconds.
    await shell.goto();

    await shell.createWorkspace();
    const newRow = shell.workspaceRows.last();
    await shell.renameWorkspace(newRow, "Untitled Project", "PTY QA");

    // powershell avoids depending on the `claude` CLI being installed.
    const harness = page.getByPlaceholder("claude");
    await harness.fill("powershell");
    await harness.press("Tab");
    await shell.startSessionButton.click();

    await page.locator(".xterm-rows").waitFor({ timeout: 15_000 });
    await page.locator(".xterm").click();
    await page.keyboard.type("echo pw-roundtrip-42");
    await page.keyboard.press("Enter");

    await expect(page.locator(".xterm-rows")).toContainText("pw-roundtrip-42", { timeout: 15_000 });

    // Hot-switch away and back; the durable session's scrollback must survive.
    await shell.workspaceRows.first().locator('[data-sidebar="menu-button"]').click();
    await shell.workspaceRows.last().locator('[data-sidebar="menu-button"]').click();
    await expect(page.locator(".xterm-rows")).toContainText("pw-roundtrip-42", { timeout: 10_000 });
  });
});
