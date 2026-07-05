import type { AgentArtifact, SpecFormat } from "@ai-storm/shared";

/**
 * Run history for convergence operations (#104) — the pure model behind the
 * {@link history} store and the HistoryPanel. Every convergence run (a spec
 * hand-off, a synthesis snapshot, a triage pass) leaves a compact, local-first
 * record so users can revisit prior generations, compare runs, and recover an
 * earlier artifact after the brainstorm moved on.
 *
 * This module is framework-free: entry shape, preview derivation, and the
 * per-project retention cap. Persistence (a Y.Doc in IndexedDB, mirroring the
 * project registry pattern) lives in `stores/history.store.ts`.
 */

/** Which convergence operation produced the entry. */
export type RunHistoryType = "spec" | "synthesis" | "triage";

/**
 * Lifecycle of a recorded run. `running` exists only while the producing
 * session is live; a reload reconciles stale `running` entries to
 * `interrupted` (see {@link reconcileStale}) so history never lies about a
 * run that can no longer complete.
 */
export type RunHistoryStatus = "running" | "done" | "empty" | "error" | "interrupted";

export interface RunHistoryEntry {
  /** Stable id (`run_<uuid>`), the Y.Map key. */
  id: string;
  projectId: string;
  type: RunHistoryType;
  status: RunHistoryStatus;
  createdAt: number;
  /** Stamped when the run reaches a terminal status. */
  finishedAt?: number;
  /** The artifact markdown (spec output / summary snapshot). `''` for metadata-only entries. */
  output: string;
  /** One-line plain-text preview of `output`, derived once at write time. */
  preview: string;
  /** Spec runs: which format the run was framed as (#110). */
  format?: SpecFormat;
  /** Spec runs: the subprocess exit code, when it exited. */
  exitCode?: number;
  /** Spec runs: structured artifacts parsed by the backend (#120), e.g. created issues. */
  artifacts?: AgentArtifact[];
  /** Synthesis / triage: how many cards the run covered at dispatch time. */
  cardCount?: number;
  /** Triage: how many `«SCORE@ref»` replies have landed so far. */
  scoredCount?: number;
}

/** Retention cap per project — history stays compact, oldest entries fall off. */
export const HISTORY_CAP_PER_PROJECT = 50;

/** Preview length cap (characters) for the history list row. */
export const PREVIEW_MAX_CHARS = 160;

/**
 * Derive the one-line list preview from an artifact's markdown: markdown
 * syntax stripped, whitespace collapsed, capped at {@link PREVIEW_MAX_CHARS}
 * with an ellipsis. Derived once at write time so list rendering never
 * re-parses stored outputs.
 */
export function historyPreview(output: string, max = PREVIEW_MAX_CHARS): string {
  const text = output
    // Fenced code blocks contribute noise, not summary — drop them whole.
    .replace(/```[\s\S]*?(```|$)/g, " ")
    // Leading heading/list/quote markers per line.
    .replace(/^[\s>]*(?:#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    // Inline emphasis/code markers (keep the text between them).
    .replace(/[*_`~]+/g, "")
    // Links: keep the label, drop the target.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Given ONE project's entries, the ids that fall off the retention cap —
 * oldest first. Callers delete these in the same transaction that inserted
 * the newest entry, so the cap holds invariantly.
 */
export function entriesOverCap(entries: readonly RunHistoryEntry[], cap = HISTORY_CAP_PER_PROJECT): string[] {
  if (entries.length <= cap) return [];
  return [...entries]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(cap)
    .map((e) => e.id);
}

/**
 * Reconcile an entry left `running` by a session that no longer exists (the
 * app reloaded mid-run). A triage that already collected scores counts as
 * `done` — partial results are results — while anything else is honestly
 * `interrupted` (the acceptance bar: failed/unfinished runs are represented
 * clearly, never shown as still in flight). Returns `null` when the entry
 * needs no change.
 */
export function reconcileStale(entry: RunHistoryEntry): RunHistoryEntry | null {
  if (entry.status !== "running") return null;
  const status: RunHistoryStatus = entry.type === "triage" && (entry.scoredCount ?? 0) > 0 ? "done" : "interrupted";
  return { ...entry, status, finishedAt: entry.finishedAt ?? Date.now() };
}
