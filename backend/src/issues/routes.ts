/**
 * Read-only GitHub issue status lookup (#125) backing the inline status shown
 * on linked idea cards. The browser can't call the GitHub API itself (no
 * credentials), so this narrow endpoint shells out to the user's own
 * authenticated `gh` CLI — the same trust boundary as the `create-issues`
 * capability (#120), but read-only (`gh issue view`).
 *
 * Deliberately narrow: the URL must be EXACTLY a GitHub issue URL (no PRs, no
 * extra path), it is passed to `gh` as a single argv token (no shell), and
 * results are cached briefly so a board full of linked cards doesn't fork one
 * `gh` per render. Linear status needs an API key and is out of scope here.
 */

import { Hono } from "hono";
import { execFile } from "node:child_process";

/** Exactly a GitHub issue URL — the whole-string gate on the `url` query. */
const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/;

/** How long a fetched status stays fresh. Issue state changes rarely. */
const CACHE_TTL_MS = 60_000;

/** Ceiling per `gh` invocation — a hung network call must not pile up. */
const GH_TIMEOUT_MS = 10_000;

export interface IssueStatus {
  state: "open" | "closed";
  title?: string;
}

/** Runs `gh issue view <url> --json state,title` and returns its stdout. */
export type GhRunner = (url: string) => Promise<string>;

const defaultRunner: GhRunner = (url) =>
  new Promise((resolve, reject) => {
    execFile(
      "gh",
      ["issue", "view", url, "--json", "state,title"],
      { timeout: GH_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      }
    );
  });

/** Parse `gh issue view --json state,title` output into an {@link IssueStatus}. */
export function parseGhIssueStatus(stdout: string): IssueStatus {
  const parsed = JSON.parse(stdout) as { state?: unknown; title?: unknown };
  const state = typeof parsed.state === "string" ? parsed.state.toLowerCase() : "";
  if (state !== "open" && state !== "closed") throw new Error(`Unexpected issue state: ${String(parsed.state)}`);
  return { state, ...(typeof parsed.title === "string" ? { title: parsed.title } : {}) };
}

export function issueRoutes(runGh: GhRunner = defaultRunner) {
  const app = new Hono();
  // url → settled lookup. Caching the promise (not the value) also collapses
  // concurrent requests for the same issue into one `gh` invocation.
  const cache = new Map<string, { at: number; result: Promise<IssueStatus> }>();

  app.get("/status", async (c) => {
    const url = c.req.query("url") ?? "";
    if (!GITHUB_ISSUE_URL.test(url)) {
      return c.json({ error: "url must be a full GitHub issue URL" }, 400);
    }

    let entry = cache.get(url);
    if (!entry || Date.now() - entry.at > CACHE_TTL_MS) {
      entry = { at: Date.now(), result: runGh(url).then(parseGhIssueStatus) };
      cache.set(url, entry);
    }

    try {
      return c.json(await entry.result);
    } catch (err) {
      // A failed lookup must not be cached as fresh — let the next ask retry.
      if (cache.get(url) === entry) cache.delete(url);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  return app;
}
