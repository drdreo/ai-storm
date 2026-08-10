import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright runner config (#84). Replaces the hand-rolled `e2e/smoke.mjs` with
 * the real `@playwright/test` runner.
 *
 * Two projects split the suite by backend dependency so the UI surface can be
 * asserted without the Node/ConPTY backend (which is Windows-only and can't run
 * on CI's ubuntu boxes):
 *
 *   • `ui`      — backend-free specs (`e2e/ui/**`): boot, shell structure,
 *                 project CRUD, theming, dialogs, empty state, tooltips. The
 *                 backend owns durable state (#233), so these run against the
 *                 fixtures' in-memory fake of the `/pty` state protocol
 *                 (`fixtures/state-backend.ts`); no Node backend is needed.
 *   • `backend` — backend-dependent specs (`e2e/backend/**`): the real PTY
 *                 round-trip and hot-switch scrollback. Requires the Node
 *                 backend on :8787; run locally, skipped on CI.
 *
 * The `webServer` auto-starts `vite dev` (frontend only) on :4200. CI runs only
 * `--project=ui`; locally, start the backend and run both.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:4200",
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },
  projects: [
    {
      name: "ui",
      testDir: "./e2e/ui",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "backend",
      testDir: "./e2e/backend",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:4200",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000
  }
});
