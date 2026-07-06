import { describe, expect, it, vi } from "vitest";
import { issueRoutes, parseGhIssueStatus } from "./routes.ts";

const ISSUE = "https://github.com/acme/app/issues/7";

describe("parseGhIssueStatus (#125)", () => {
  it("normalizes gh's uppercase state and keeps the title", () => {
    expect(parseGhIssueStatus('{"state":"OPEN","title":"Add dark mode"}')).toEqual({
      state: "open",
      title: "Add dark mode"
    });
    expect(parseGhIssueStatus('{"state":"CLOSED"}')).toEqual({ state: "closed" });
  });

  it("rejects unexpected states and malformed JSON", () => {
    expect(() => parseGhIssueStatus('{"state":"MERGED"}')).toThrow(/Unexpected issue state/);
    expect(() => parseGhIssueStatus("not json")).toThrow();
  });
});

describe("GET /status (#125)", () => {
  it("returns the parsed status for a valid issue URL", async () => {
    const runGh = vi.fn().mockResolvedValue('{"state":"OPEN","title":"Add dark mode"}');
    const app = issueRoutes(runGh);
    const res = await app.request(`/status?url=${encodeURIComponent(ISSUE)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "open", title: "Add dark mode" });
    expect(runGh).toHaveBeenCalledWith(ISSUE);
  });

  it("rejects anything that is not exactly a GitHub issue URL", async () => {
    const runGh = vi.fn();
    const app = issueRoutes(runGh);
    for (const bad of [
      "",
      "https://github.com/acme/app/pull/7",
      "https://github.com/acme/app/issues/7/comments",
      "https://linear.app/acme/issue/ENG-1",
      "https://github.com/acme/app/issues/7 --help"
    ]) {
      const res = await app.request(`/status?url=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
    }
    expect(runGh).not.toHaveBeenCalled();
  });

  it("caches a fresh result instead of re-running gh", async () => {
    const runGh = vi.fn().mockResolvedValue('{"state":"OPEN"}');
    const app = issueRoutes(runGh);
    await app.request(`/status?url=${encodeURIComponent(ISSUE)}`);
    await app.request(`/status?url=${encodeURIComponent(ISSUE)}`);
    expect(runGh).toHaveBeenCalledTimes(1);
  });

  it("returns 502 on a gh failure and retries on the next request", async () => {
    const runGh = vi.fn().mockRejectedValueOnce(new Error("gh: not logged in")).mockResolvedValue('{"state":"CLOSED"}');
    const app = issueRoutes(runGh);
    const fail = await app.request(`/status?url=${encodeURIComponent(ISSUE)}`);
    expect(fail.status).toBe(502);
    expect(await fail.json()).toEqual({ error: "gh: not logged in" });
    const ok = await app.request(`/status?url=${encodeURIComponent(ISSUE)}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ state: "closed" });
    expect(runGh).toHaveBeenCalledTimes(2);
  });
});
