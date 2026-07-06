import { test, expect } from "../fixtures/shell";

/**
 * Run history (#104). Backend-free coverage of the acceptance criteria that
 * need a real browser: a convergence run leaves a history entry, the entry
 * survives a reload (CRDT store in IndexedDB), an empty run is represented
 * clearly, and history can be cleared. The agent-run (spec/triage) recording
 * paths are unit-tested in the stores — no live session exists in this suite.
 */
test.describe("run history", () => {
  const openHistory = async (page: import("@playwright/test").Page) => {
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByRole("heading", { name: "Run history" })).toBeVisible();
  };

  test("summarize snapshots into history, survives reload, and can be cleared", async ({ shell, page }) => {
    // Two full app boots (before/after reload) — give it the tripled budget.
    test.slow();
    await shell.goto();

    // Take a synthesis snapshot (empty board → an "empty" run, represented clearly).
    await page.getByRole("button", { name: "Summarize" }).click();
    await expect(page.getByRole("heading", { name: "Board summary" })).toBeVisible();
    await page.keyboard.press("Escape");

    await openHistory(page);
    const row = page.getByRole("button", { name: /Summary/ }).filter({ hasText: "no output" });
    await expect(row).toBeVisible();

    // Reload — the entry must come back from IndexedDB.
    await shell.goto();
    await openHistory(page);
    await expect(row).toBeVisible();

    // Reopen the entry: the empty run explains itself; nothing to copy.
    await row.click();
    await expect(page.getByText("The run produced no output.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy markdown" })).toBeDisabled();

    // Back to the list, clear the project's history.
    await page.getByRole("button", { name: "Back to history list" }).click();
    await page.getByRole("button", { name: "Clear history" }).click();
    await expect(page.getByText("No runs yet", { exact: false })).toBeVisible();
  });
});
