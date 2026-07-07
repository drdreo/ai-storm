import { test, expect } from "../fixtures/shell";
import type { Locator, Page } from "@playwright/test";

/**
 * Intro tour (#179). The only spec that runs without the `as:tours=off` kill
 * switch, so the tour auto-starts exactly like a real first launch: stepping
 * through (or dismissing) records the outcome and the tour never auto-starts
 * again — asserted across a reload.
 */
test.use({ toursEnabled: true });

const FIRST_STEP_TITLE = "Projects live here";

/** All Joyride UI renders inside its portal — scoping avoids strict-mode
 * collisions with app chrome (the last step is titled "Settings", which the
 * sidebar footer also says). */
function tour(page: Page): Locator {
  return page.locator("#react-joyride-portal");
}

test.describe("intro tour", () => {
  test("auto-starts on first launch, completes, and never auto-starts again", async ({
    shell,
    page,
    consoleErrors
  }) => {
    await shell.goto();

    // Fresh profile → the tour auto-starts on the first step.
    await expect(tour(page).getByText(FIRST_STEP_TITLE)).toBeVisible();

    // Step through all five steps; the last primary button reads "Done".
    for (const title of ["Your board", "The control hub", "The command palette", "Settings"]) {
      await tour(page).getByRole("button", { name: /^Next/ }).click();
      await expect(tour(page).getByText(title, { exact: true })).toBeVisible();
    }
    await tour(page).getByRole("button", { name: "Done" }).click();
    await expect(tour(page).getByText(FIRST_STEP_TITLE)).toBeHidden();

    // Finishing persists the outcome…
    expect(await page.evaluate(() => localStorage.getItem("as:tour-intro"))).toBe("done");

    // …so a reload must not resurrect the tour.
    await shell.goto();
    await expect(shell.canvas).toBeVisible();
    await expect(tour(page).getByText(FIRST_STEP_TITLE)).toBeHidden();

    expect(consoleErrors).toEqual([]);
  });

  test("dismissing via the close button also counts as seen", async ({ shell, page, consoleErrors }) => {
    await shell.goto();
    await expect(tour(page).getByText(FIRST_STEP_TITLE)).toBeVisible();

    // The X is wired to skip (ends the whole tour, not just the step).
    await tour(page).getByRole("button", { name: "Close" }).click();
    await expect(tour(page).getByText(FIRST_STEP_TITLE)).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("as:tour-intro"))).toBe("dismissed");

    await shell.goto();
    await expect(tour(page).getByText(FIRST_STEP_TITLE)).toBeHidden();

    expect(consoleErrors).toEqual([]);
  });

  test("is replayable from Settings after being seen", async ({ shell, page }) => {
    await shell.goto();
    await tour(page).getByRole("button", { name: "Close" }).click();
    await expect(tour(page).getByText(FIRST_STEP_TITLE)).toBeHidden();

    const dialog = await shell.openSettings();
    await dialog.getByRole("button", { name: "Intro tour" }).click();
    await expect(tour(page).getByText(FIRST_STEP_TITLE)).toBeVisible();
  });
});

test.describe("power tour", () => {
  test("never auto-runs before the milestone, but replays from Settings", async ({ shell, page, consoleErrors }) => {
    await shell.goto();
    // Get the auto-started intro tour out of the way first.
    await tour(page).getByRole("button", { name: "Close" }).click();

    // No session, no cards — neither the tour nor its offer may appear.
    await expect(tour(page).getByText("The card verb bar")).toBeHidden();
    await expect(page.getByText("Take the power tour?")).toBeHidden();

    // Settings replay bypasses the milestone gate entirely.
    const dialog = await shell.openSettings();
    await dialog.getByRole("button", { name: "Power tour" }).click();
    await expect(tour(page).getByText("The card verb bar")).toBeVisible();

    // Step through all seven steps; toolbar-anchored ones included.
    for (const title of [
      "Triage",
      "Arrange layouts",
      "Filters",
      "Summarize & Stats",
      "Export to format",
      "Focus mode"
    ]) {
      await tour(page).getByRole("button", { name: /^Next/ }).click();
      await expect(tour(page).getByText(title, { exact: true })).toBeVisible();
    }
    await tour(page).getByRole("button", { name: "Done" }).click();
    await expect(tour(page).getByText("Focus mode")).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem("as:tour-power"))).toBe("done");

    expect(consoleErrors).toEqual([]);
  });
});
