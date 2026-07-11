import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { FakeStateBackend } from "./state-backend";

/**
 * Page object for the ai-storm shell (#84). Keeps specs readable by naming the
 * three structural surfaces — sidebar, canvas, control hub — and the handful of
 * interactions the suite drives (create/rename/switch a project, open
 * settings). Mirror selectors used by the old `smoke.mjs` so coverage carries
 * over verbatim.
 */
export class Shell {
  constructor(readonly page: Page) {}

  get projectRows(): Locator {
    return this.page.locator(".group\\/ws-row");
  }

  get folderRows(): Locator {
    return this.page.locator(".group\\/folder");
  }

  /** The tldraw spatial surface (left pane). */
  get canvas(): Locator {
    return this.page.locator(".tl-container").first();
  }

  /** The sidebar's "New…" dropdown trigger (offers "New project" / "New folder"). */
  get newMenuButton(): Locator {
    return this.page.getByRole("button", { name: "New project or folder" });
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
    await expect(this.page.getByText("AI Storm", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(this.projectRows.first()).toBeVisible({ timeout: 10_000 });
    await expect(this.canvas).toBeVisible({ timeout: 15_000 });
  }

  /** Create a project via the "New…" menu; resolves once the row count grows. */
  async createProject(): Promise<void> {
    const before = await this.projectRows.count();
    await this.newMenuButton.click();
    await this.page.getByRole("menuitem", { name: "New project" }).click();
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

  async createFolder(name?: string): Promise<void> {
    const before = await this.folderRows.count();
    await this.newMenuButton.click();
    await this.page.getByRole("menuitem", { name: "New folder" }).click();
    if (name) {
      await this.page.keyboard.type(name);
      await this.page.keyboard.press("Enter");
    }
    await expect(this.folderRows).toHaveCount(before + 1);
  }

  /** Open the appearance Settings dialog from the sidebar footer. */
  async openSettings(): Promise<Locator> {
    await this.settingsButton.click();
    const dialog = this.page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Settings" })).toBeVisible();
    return dialog;
  }

  /**
   * Names of the IndexedDB databases the app has opened in this page. Since
   * #233 the app must not create any — asserted by shell.spec.
   */
  async indexedDbNames(): Promise<string[]> {
    return this.page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? "").filter(Boolean));
  }
}

/**
 * Connecting to the local backend fails in the backend-free UI suite, so the
 * browser logs `WebSocket` connection noise, plus a browser-level "Failed to
 * load resource" entry for any proxied `/api/*` request that 502s (e.g.
 * ControlHub's best-effort `/api/fs/home` cwd lookup) — that failure is
 * already caught in app code, but Chrome still logs the raw network error to
 * the console regardless of the JS catch. Filter it so a genuine app error
 * still trips `expectNoConsoleErrors`.
 */
const BACKEND_OFFLINE_NOISE = /websocket|ws:\/\/|\/pty|failed to fetch|\/health|\/api\/|bad gateway|502/i;

export const test = base.extend<{
  toursEnabled: boolean;
  stateBackend: FakeStateBackend;
  shell: Shell;
  consoleErrors: string[];
}>({
  /**
   * The intro tour (#179) auto-starts on a fresh profile, which every spec
   * here is. Its overlay would sit on top of whatever a spec is asserting, so
   * the suite runs with the `as:tours=off` kill switch preloaded; only
   * `tour.spec.ts` opts back in via `test.use({ toursEnabled: true })`.
   */
  toursEnabled: [false, { option: true }],
  /**
   * The backend filesystem is the sole durable authority (#233), so the app
   * refuses to boot without a `/pty` socket. The fake serves the state
   * protocol from per-test memory — fresh isolated state per test, surviving
   * reloads within one — while PTY/session traffic stays absent, keeping the
   * suite's backend-free premise for everything session-shaped.
   */
  stateBackend: async ({ page }, use) => {
    const fake = new FakeStateBackend();
    await fake.install(page);
    await use(fake);
  },
  page: async ({ page, toursEnabled }, use) => {
    if (!toursEnabled) {
      await page.addInitScript(() => localStorage.setItem("as:tours", "off"));
    }
    await use(page);
  },
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
  shell: async ({ page, stateBackend }, use) => {
    void stateBackend; // Depend on the fixture so the fake is routed before goto().
    await use(new Shell(page));
  }
});

export { expect };
