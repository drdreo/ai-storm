/**
 * Tests for the run-history model (#104): preview derivation, the per-project
 * retention cap, and stale-run reconciliation after a reload.
 */

import { describe, it, expect } from "vitest";
import { entriesOverCap, historyPreview, reconcileStale, type RunHistoryEntry } from "./run-history";

function entry(overrides: Partial<RunHistoryEntry>): RunHistoryEntry {
  return {
    id: "run_x",
    projectId: "ws1",
    type: "spec",
    status: "done",
    createdAt: 0,
    output: "",
    preview: "",
    ...overrides
  };
}

describe("historyPreview (#104)", () => {
  it("strips markdown structure down to one plain line", () => {
    const md = "# PRD: Dark mode\n\n## Goals\n\n- **Fast** toggle\n- Respect `prefers-color-scheme`\n";
    const preview = historyPreview(md);
    expect(preview).toBe("PRD: Dark mode Goals Fast toggle Respect prefers-color-scheme");
  });

  it("drops fenced code blocks entirely", () => {
    const md = "Intro line\n```ts\nconst x = secret();\n```\nOutro line";
    expect(historyPreview(md)).toBe("Intro line Outro line");
  });

  it("keeps link labels but drops targets", () => {
    expect(historyPreview("See [the issue](https://github.com/x/y/issues/1) for context")).toBe(
      "See the issue for context"
    );
  });

  it("caps long output with an ellipsis", () => {
    const preview = historyPreview("word ".repeat(100), 40);
    expect(preview.length).toBeLessThanOrEqual(40);
    expect(preview.endsWith("…")).toBe(true);
  });

  it("returns '' for empty output", () => {
    expect(historyPreview("")).toBe("");
    expect(historyPreview("   \n  ")).toBe("");
  });
});

describe("entriesOverCap (#104)", () => {
  it("returns nothing while under the cap", () => {
    const entries = [entry({ id: "a", createdAt: 1 }), entry({ id: "b", createdAt: 2 })];
    expect(entriesOverCap(entries, 2)).toEqual([]);
  });

  it("returns the oldest ids beyond the cap regardless of input order", () => {
    const entries = [
      entry({ id: "old", createdAt: 1 }),
      entry({ id: "newest", createdAt: 4 }),
      entry({ id: "oldest", createdAt: 0 }),
      entry({ id: "new", createdAt: 3 })
    ];
    expect(entriesOverCap(entries, 2)).toEqual(["old", "oldest"]);
  });
});

describe("reconcileStale (#104)", () => {
  it("leaves finished entries alone", () => {
    expect(reconcileStale(entry({ status: "done" }))).toBeNull();
    expect(reconcileStale(entry({ status: "error" }))).toBeNull();
  });

  it("marks an orphaned running spec as interrupted with a finish time", () => {
    const fixed = reconcileStale(entry({ status: "running", type: "spec" }));
    expect(fixed?.status).toBe("interrupted");
    expect(fixed?.finishedAt).toBeTypeOf("number");
  });

  it("counts a partially-scored triage as done (partial results are results)", () => {
    const fixed = reconcileStale(entry({ status: "running", type: "triage", cardCount: 8, scoredCount: 3 }));
    expect(fixed?.status).toBe("done");
  });

  it("marks a triage with no scores as interrupted", () => {
    const fixed = reconcileStale(entry({ status: "running", type: "triage", cardCount: 8, scoredCount: 0 }));
    expect(fixed?.status).toBe("interrupted");
  });
});
