import { test as base, expect, type Locator, type Page } from "@playwright/test";

/**
 * Page object for the ai-storm shell (#84). Keeps specs readable by naming the
 * three structural surfaces — sidebar, canvas, control hub — and the handful of
 * interactions the suite drives (create/rename/switch a project, open
 * settings). Mirror selectors used by the old `smoke.mjs` so coverage carries
 * over verbatim.
 */
export class Shell {
  constructor(readonly page: Page) {}

  /**
   * Project rows in the sidebar. The brand header and the footer (backend
   * status, Settings) are also `data-sidebar="menu-item"` rows, so scope to the
   * ones carrying a per-row "Manage" kebab — only real projects have one.
   */
  get projectRows(): Locator {
    return this.page
      .locator('[data-sidebar="menu-item"]')
      .filter({ has: this.page.getByRole("button", { name: /^Manage / }) });
  }

  /** The tldraw spatial surface (left pane). */
  get canvas(): Locator {
    return this.page.locator(".tl-container").first();
  }

  get newProjectButton(): Locator {
    return this.page.getByRole("button", { name: "New project" });
  }

  /**
   * The Control Hub's "Start session" button. Scoped to the "Session controls"
   * toolbar because the canvas empty-state (#106) offers its own same-labelled
   * "Start session" button, so a bare name match is ambiguous.
   */
  get startSessionButton(): Locator {
    return this.page.getByRole("toolbar", { name: "Session controls" }).getByRole("button", { name: "Start session" });
  }

  /**
   * The sidebar-footer Settings button. `exact` so it doesn't also match the
   * canvas empty-state's "Open settings" button (#106).
   */
  get settingsButton(): Locator {
    return this.page.getByRole("button", { name: "Settings", exact: true });
  }

  /** Navigate to the app and wait for the shell to boot past crash-recovery. */
  async goto(): Promise<void> {
    await this.page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(this.page.getByText("ai-storm", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(this.projectRows.first()).toBeVisible({ timeout: 10_000 });
    await expect(this.canvas).toBeVisible({ timeout: 15_000 });
  }

  /** Create a project via the (+) action; resolves once the row count grows. */
  async createProject(): Promise<void> {
    const before = await this.projectRows.count();
    await this.newProjectButton.click();
    await expect(this.projectRows).toHaveCount(before + 1);
  }

  /** Inline-rename a project row by double-clicking its label and committing. */
  async renameProject(row: Locator, from: string, to: string): Promise<void> {
    await row.getByText(from).dblclick();
    // The editing row swaps its content for an input (and drops its "Manage"
    // kebab, so a row-scoped, kebab-filtered locator would stop matching it).
    // Only one rename input exists at a time — target it at the page level.
    const input = this.page.getByRole("textbox", { name: "Rename project" });
    await input.waitFor();
    await input.fill(to);
    await input.press("Enter");
    await expect(this.projectRows.getByText(to)).toBeVisible();
  }

  /** Open the appearance Settings dialog from the sidebar footer. */
  async openSettings(): Promise<Locator> {
    await this.settingsButton.click();
    const dialog = this.page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
    return dialog;
  }

  /** Names of the IndexedDB databases the app has opened in this page. */
  async indexedDbNames(): Promise<string[]> {
    return this.page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? "").filter(Boolean));
  }
}

/**
 * Connecting to the local backend fails in the backend-free UI suite, so the
 * browser logs `WebSocket` connection noise. Filter it so a genuine app error
 * still trips `expectNoConsoleErrors`.
 */
const BACKEND_OFFLINE_NOISE = /websocket|ws:\/\/|\/pty|failed to fetch|\/health/i;

export const test = base.extend<{ shell: Shell; consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error" && !BACKEND_OFFLINE_NOISE.test(m.text())) errors.push(m.text());
    });
    page.on("pageerror", (e) => {
      if (!BACKEND_OFFLINE_NOISE.test(String(e))) errors.push(String(e));
    });
    await use(errors);
  },
  shell: async ({ page }, use) => {
    await use(new Shell(page));
  }
});

export { expect };
