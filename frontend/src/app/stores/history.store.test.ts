/**
 * Tests for the run-history store (#104): recording, finishing, triage score
 * counting, synthesis dedupe, the retention cap, and boot-time reconciliation
 * of runs orphaned by a reload.
 *
 * The store is a module singleton, so each test gets a fresh module via
 * `vi.resetModules()` + dynamic import.
 */

import { describe, it, expect, vi } from "vitest";

async function freshStore() {
  vi.resetModules();
  return import("./history.store");
}

describe("history.record / finish (#104)", () => {
  it("records a running spec entry and finishes it into a done artifact", async () => {
    const { history, useHistoryStore } = await freshStore();
    const id = history.record({ projectId: "ws1", type: "spec", format: "prd" });

    let entry = useHistoryStore.getState().entries.find((e) => e.id === id)!;
    expect(entry.status).toBe("running");
    expect(entry.format).toBe("prd");
    expect(entry.finishedAt).toBeUndefined();

    history.finish(id, { status: "done", output: "# PRD\n\nDark mode.", exitCode: 0 });
    entry = useHistoryStore.getState().entries.find((e) => e.id === id)!;
    expect(entry.status).toBe("done");
    expect(entry.output).toBe("# PRD\n\nDark mode.");
    expect(entry.preview).toBe("PRD Dark mode.");
    expect(entry.exitCode).toBe(0);
    expect(entry.finishedAt).toBeTypeOf("number");
  });

  it("keeps entries newest-first across projects", async () => {
    const { history, useHistoryStore } = await freshStore();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      history.record({ projectId: "ws1", type: "spec" });
      vi.setSystemTime(2_000);
      const newest = history.record({ projectId: "ws2", type: "triage" });
      const entries = useHistoryStore.getState().entries;
      expect(entries[0].id).toBe(newest);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the per-project retention cap, dropping oldest first", async () => {
    const { history, useHistoryStore } = await freshStore();
    const core = await import("../core/run-history");
    vi.useFakeTimers();
    try {
      for (let i = 0; i <= core.HISTORY_CAP_PER_PROJECT; i++) {
        vi.setSystemTime(1_000 + i);
        history.record({ projectId: "ws1", type: "synthesis", status: "done", output: `run ${i}` });
      }
      const entries = useHistoryStore.getState().entries;
      expect(entries.length).toBe(core.HISTORY_CAP_PER_PROJECT);
      expect(entries.some((e) => e.output === "run 0")).toBe(false);
      expect(entries.some((e) => e.output === `run ${core.HISTORY_CAP_PER_PROJECT}`)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("history.recordSynthesis (#104)", () => {
  it("collapses consecutive identical snapshots into one refreshed entry", async () => {
    const { history, useHistoryStore } = await freshStore();
    const first = history.recordSynthesis("ws1", "# Board summary\n\n- Idea", 1);
    const second = history.recordSynthesis("ws1", "# Board summary\n\n- Idea", 1);
    expect(second).toBe(first);
    expect(useHistoryStore.getState().entries.length).toBe(1);
  });

  it("records a changed board as a new entry, and an empty board as 'empty'", async () => {
    const { history, useHistoryStore } = await freshStore();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      history.recordSynthesis("ws1", "# Board summary\n\n- Idea", 1);
      vi.setSystemTime(2_000);
      history.recordSynthesis("ws1", "", 0);
      const entries = useHistoryStore.getState().entries;
      expect(entries.length).toBe(2);
      expect(entries[0].status).toBe("empty");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("history.noteTriageScore (#104)", () => {
  it("counts scores toward the in-flight triage and completes at cardCount", async () => {
    const { history, useHistoryStore } = await freshStore();
    const id = history.record({ projectId: "ws1", type: "triage", cardCount: 2 });

    history.noteTriageScore("ws1");
    let entry = useHistoryStore.getState().entries.find((e) => e.id === id)!;
    expect(entry.scoredCount).toBe(1);
    expect(entry.status).toBe("running");

    history.noteTriageScore("ws1");
    entry = useHistoryStore.getState().entries.find((e) => e.id === id)!;
    expect(entry.scoredCount).toBe(2);
    expect(entry.status).toBe("done");
    expect(entry.finishedAt).toBeTypeOf("number");
  });

  it("ignores scores with no in-flight triage entry", async () => {
    const { history, useHistoryStore } = await freshStore();
    history.noteTriageScore("ws1");
    expect(useHistoryStore.getState().entries).toEqual([]);
  });
});

describe("history removal (#104)", () => {
  it("remove() deletes one entry; removeProject() clears only that project", async () => {
    const { history, useHistoryStore } = await freshStore();
    const a = history.record({ projectId: "ws1", type: "spec" });
    history.record({ projectId: "ws1", type: "triage" });
    history.record({ projectId: "ws2", type: "synthesis", status: "done", output: "kept" });

    history.remove(a);
    expect(useHistoryStore.getState().entries.length).toBe(2);

    history.removeProject("ws1");
    const entries = useHistoryStore.getState().entries;
    expect(entries.length).toBe(1);
    expect(entries[0].projectId).toBe("ws2");
  });
});

describe("history.boot (#104)", () => {
  it("reconciles entries orphaned as 'running' by a reload", async () => {
    const { history, useHistoryStore } = await freshStore();
    history.record({ projectId: "ws1", type: "spec", format: "prd" });
    const triage = history.record({ projectId: "ws1", type: "triage", cardCount: 4 });
    history.noteTriageScore("ws1");

    await history.boot();

    const entries = useHistoryStore.getState().entries;
    expect(entries.find((e) => e.type === "spec")?.status).toBe("interrupted");
    expect(entries.find((e) => e.id === triage)?.status).toBe("done");
  });
});
