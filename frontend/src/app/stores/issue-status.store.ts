/**
 * Linked-issue status cache (#125) — backs the open/closed dot on a card's
 * issue link chips. Statuses are fetched lazily through the backend's
 * `/api/issues/status` endpoint (which shells out to the user's authenticated
 * `gh`), cached per URL for the app's lifetime, and shared across every chip
 * that shows the same issue. GitHub only — Linear status needs an API key and
 * is not fetched; its chips simply render without a dot.
 */

import { create } from "zustand";
import { GITHUB_ISSUE_URL } from "../core/issue-links";
import { log } from "../../lib/log";

export interface FetchedIssueStatus {
  /** `unknown` = the lookup failed (offline, `gh` unauthenticated, …). */
  state: "open" | "closed" | "unknown";
  title?: string;
}

interface IssueStatusState {
  statuses: Record<string, FetchedIssueStatus | undefined>;
}

export const useIssueStatusStore = create<IssueStatusState>(() => ({ statuses: {} }));

/** URLs with a lookup in flight — a board of chips asks once per issue. */
const inflight = new Set<string>();

export const issueStatus = {
  /**
   * Ensure a status for `url` is (being) fetched. No-op for non-GitHub-issue
   * URLs, cached URLs, and in-flight lookups — safe to call from render
   * effects on every card. Failures cache as `unknown` (no retry storm); a
   * reload asks again.
   */
  request(url: string): void {
    if (!GITHUB_ISSUE_URL.test(url)) return;
    if (inflight.has(url) || useIssueStatusStore.getState().statuses[url]) return;
    inflight.add(url);
    void fetch(`/api/issues/status?url=${encodeURIComponent(url)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as { state: "open" | "closed"; title?: string };
        set(url, body);
      })
      .catch((err) => {
        log.warn("issue_status.fetch_failed", { url, error: String(err) });
        set(url, { state: "unknown" });
      })
      .finally(() => inflight.delete(url));
  }
};

function set(url: string, status: FetchedIssueStatus): void {
  useIssueStatusStore.setState((s) => ({ statuses: { ...s.statuses, [url]: status } }));
}
