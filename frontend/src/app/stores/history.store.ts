import { create } from "zustand";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import {
  entriesOverCap,
  historyPreview,
  reconcileStale,
  type RunHistoryEntry,
  type RunHistoryStatus,
  type RunHistoryType
} from "../core/run-history";
import type { AgentArtifact, SpecFormat } from "@ai-storm/shared";

const HISTORY_ROOM = "ai-storm-run-history";

/**
 * Per-project run history for convergence operations (#104): spec/PRD
 * hand-offs, synthesis snapshots, and triage metadata.
 *
 * Persistence mirrors the project registry (PRD §3.5): a dedicated CRDT Y.Doc
 * backed by its own IndexedDB store, so every write lands immediately and
 * survives crashes/reloads — history stays local-first, no backend involved.
 * Entries live in a Y.Map keyed by entry id; the reactive surface is a small
 * Zustand store holding the newest-first list the HistoryPanel renders.
 *
 * Recording points:
 *  - `agent.generateSpec` records a running spec entry and finishes it from
 *    the run's exit/error (agent.store).
 *  - `agent.triage` records a metadata entry; each extracted score bumps it
 *    via {@link history.noteTriageScore} (ingestion.store).
 *  - The Summarize action snapshots its markdown via
 *    {@link history.recordSynthesis} (CanvasPane).
 */

interface HistoryState {
  /** All entries across projects, newest first. */
  entries: RunHistoryEntry[];
}

export const useHistoryStore = create<HistoryState>(() => ({ entries: [] }));

/** Derived: one project's entries (input list is already newest-first). */
export function projectHistory(entries: readonly RunHistoryEntry[], projectId: string): RunHistoryEntry[] {
  return entries.filter((e) => e.projectId === projectId);
}

// ---- Imperative CRDT singletons (outside React) ----------------------------

const historyDoc = new Y.Doc();
const map = historyDoc.getMap<RunHistoryEntry>("runs");
let persistence: IndexeddbPersistence | undefined;
let booted = false;

function syncFromMap(): void {
  const list: RunHistoryEntry[] = [];
  map.forEach((entry) => list.push(entry));
  list.sort((a, b) => b.createdAt - a.createdAt);
  useHistoryStore.setState({ entries: list });
}

// Observe at module scope (not in boot) so writes reflect into the reactive
// state even before persistence attaches — record points fire only after app
// boot in practice, but tests exercise the store without IndexedDB.
map.observe(() => syncFromMap());

function write(entry: RunHistoryEntry): void {
  map.set(entry.id, { ...entry });
}

function patchEntry(id: string, patch: Partial<RunHistoryEntry>): void {
  const cur = map.get(id);
  if (!cur) return;
  const next: RunHistoryEntry = { ...cur, ...patch };
  if (patch.output !== undefined) next.preview = historyPreview(patch.output);
  if (patch.status && patch.status !== "running" && next.finishedAt === undefined) next.finishedAt = Date.now();
  write(next);
}

export const history = {
  /**
   * Attach IndexedDB persistence and rehydrate (called alongside
   * `project.boot`). Idempotent. Any entry still `running` was orphaned by a
   * reload — reconcile it so history never shows a dead run as in flight.
   */
  async boot(): Promise<void> {
    if (booted) return;
    booted = true;
    persistence = new IndexeddbPersistence(HISTORY_ROOM, historyDoc);
    await new Promise<void>((resolve) => {
      persistence!.once("synced", () => resolve());
    });
    historyDoc.transact(() => {
      map.forEach((entry) => {
        const fixed = reconcileStale(entry);
        if (fixed) write(fixed);
      });
    });
    syncFromMap();
  },

  /**
   * Record a new run entry, enforcing the per-project retention cap in the
   * same transaction. Terminal-status entries (a synthesis snapshot is done
   * the moment it's taken) get `finishedAt` stamped immediately.
   *
   * @returns the new entry's id, for later {@link update}/{@link finish} calls.
   */
  record(input: {
    projectId: string;
    type: RunHistoryType;
    status?: RunHistoryStatus;
    output?: string;
    format?: SpecFormat;
    cardCount?: number;
  }): string {
    const id = `run_${crypto.randomUUID()}`;
    const now = Date.now();
    const status = input.status ?? "running";
    const output = input.output ?? "";
    const entry: RunHistoryEntry = {
      id,
      projectId: input.projectId,
      type: input.type,
      status,
      createdAt: now,
      finishedAt: status !== "running" ? now : undefined,
      output,
      preview: historyPreview(output),
      format: input.format,
      cardCount: input.cardCount,
      scoredCount: input.type === "triage" ? 0 : undefined
    };
    historyDoc.transact(() => {
      write(entry);
      const siblings: RunHistoryEntry[] = [];
      map.forEach((e) => {
        if (e.projectId === input.projectId) siblings.push(e);
      });
      for (const stale of entriesOverCap(siblings)) map.delete(stale);
    });
    return id;
  },

  /**
   * Snapshot a synthesis run (#28 → #104). Consecutive identical snapshots
   * are collapsed — reopening the summary panel over an unchanged board
   * refreshes the latest entry's timestamp instead of duplicating it.
   */
  recordSynthesis(projectId: string, output: string, cardCount: number): string {
    const latest = useHistoryStore.getState().entries.find((e) => e.projectId === projectId && e.type === "synthesis");
    if (latest && latest.output === output) {
      const now = Date.now();
      patchEntry(latest.id, { createdAt: now, finishedAt: now, cardCount });
      return latest.id;
    }
    return history.record({
      projectId,
      type: "synthesis",
      status: output.trim() ? "done" : "empty",
      output,
      cardCount
    });
  },

  /** Patch a live entry (e.g. the backend-echoed spec format, artifacts). */
  update(id: string, patch: Partial<Pick<RunHistoryEntry, "format" | "artifacts" | "cardCount">>): void {
    patchEntry(id, patch);
  },

  /** Finish a run: terminal status, final output, exit code; `finishedAt` stamped. */
  finish(
    id: string,
    result: {
      status: Exclude<RunHistoryStatus, "running">;
      output?: string;
      exitCode?: number;
      artifacts?: AgentArtifact[];
    }
  ): void {
    patchEntry(id, result);
  },

  /**
   * A triage score landed (#60 → #104): bump the project's most recent
   * in-flight triage entry; once every dispatched card is scored, the run
   * is done.
   */
  noteTriageScore(projectId: string): void {
    const entry = useHistoryStore
      .getState()
      .entries.find((e) => e.projectId === projectId && e.type === "triage" && e.status === "running");
    if (!entry) return;
    const scoredCount = (entry.scoredCount ?? 0) + 1;
    const complete = entry.cardCount !== undefined && scoredCount >= entry.cardCount;
    patchEntry(entry.id, complete ? { scoredCount, status: "done" } : { scoredCount });
  },

  /** Delete a single entry (the HistoryPanel's per-row delete). */
  remove(id: string): void {
    map.delete(id);
  },

  /** Drop every entry for a project — panel "Clear history" and project deletion. */
  removeProject(projectId: string): void {
    historyDoc.transact(() => {
      const doomed: string[] = [];
      map.forEach((e, key) => {
        if (e.projectId === projectId) doomed.push(key);
      });
      for (const key of doomed) map.delete(key);
    });
  }
};
