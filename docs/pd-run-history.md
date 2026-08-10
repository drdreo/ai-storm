# PD: Run History for Synthesis, Triage & Spec Hand-off

**Issue:** #104 · **PR:** #185

## Problem

Generated outputs (spec/PRD hand-offs, synthesis snapshots, triage passes) are useful but transient. Once a panel closes or the page reloads, the output is gone — users can't revisit a prior spec generation, recover an earlier synthesis after continuing the brainstorm, or check what a triage run actually did.

## Goal

Give each project a local-first, persistent record of these three "convergence operations" so past runs remain reviewable after the fact.

## Scope

Three recording seams, one history store, one viewing panel:

- **Spec / PRD hand-off** (`agent.generateSpec`) — opens a `running` entry, finishes as `done` / `empty` / `error` with full output, exit code, and any created-issue links.
- **Triage** (`agent.triage`) — records request metadata (card count at dispatch); each scored card bumps a counter, flips to `done` once every card is scored.
- **Synthesis** (Summarize action) — snapshots the markdown output; identical consecutive snapshots collapse into one refreshed entry instead of duplicating.

## Behavior

- **Per-project**: history belongs to the project, not the session. Deleting a project drops its history.
- **Capped**: 50 entries per project; oldest fall off automatically.
- **Survives reload**: entries persist across page reloads. Anything left `running` by a reload is reconciled at boot — a partially-scored triage is counted `done`, everything else becomes `interrupted`. History never shows a dead run as still in flight.
- **Status is explicit**: every entry shows one of `running` / `done` / `empty` / `error` / `interrupted`, with explanatory copy in the detail view for the non-happy paths.
- **Reopenable**: selecting an entry opens the stored artifact in the same markdown viewer used by the live panel, with the same Copy/Download actions and (for spec runs) created-issue chips.
- **Manageable**: entries can be deleted individually or cleared project-wide.

## UI entry points

- Toolbar **History** button.
- Command palette → "Run history".

Both open the same `HistoryPanel`, code-split and lazy-loaded like the existing `SpecPanel`.

## Storage approach

History is part of the backend-owned project state. The frontend's Zustand history
store loads and mutates each project's `history.json` through the shared WebSocket
state protocol (`history-load`, `history-append`, `history-update`,
`history-delete`, and `history-clear`). `backend/src/state/store.ts` serializes
and atomically writes the file, so history survives browser reloads, reconnects,
and backend restarts alongside the board and registry. The frontend remains an
optimistic projection; it does not maintain a second durable history store.

## Acceptance criteria

- ✅ Completed spec outputs can be reopened after closing the panel.
- ✅ History survives reload.
- ✅ Failed/empty/interrupted runs are represented clearly.
- ✅ Copy/download works from historical entries.

## Non-goals

- No cross-project or cross-device history; the backend store is local to the
  machine running ai-storm.
- No diffing/comparison between runs (mentioned as a motivating use case in the issue, not built here).
