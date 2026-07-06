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

Follows the existing project-registry persistence pattern: a dedicated CRDT doc (`ai-storm-run-history`) persisted to its own IndexedDB store via `y-indexeddb`, booted alongside `project.boot()`. No backend involvement — history is local-first by design, matching the rest of the app's persistence model.

## Acceptance criteria

- ✅ Completed spec outputs can be reopened after closing the panel.
- ✅ History survives reload.
- ✅ Failed/empty/interrupted runs are represented clearly.
- ✅ Copy/download works from historical entries.

## Non-goals

- No cross-project or cross-device history.
- No diffing/comparison between runs (mentioned as a motivating use case in the issue, not built here).
- No server-side/backend persistence — this is IndexedDB-only.
