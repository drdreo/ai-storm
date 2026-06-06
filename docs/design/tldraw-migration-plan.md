# Migration plan: BlockSuite → tldraw canvas

> **Note:** the repo's root `plan.md` is the unrelated *terminal-passthrough* plan;
> this is the canvas-migration plan and lives here beside the spike report.

**Goal:** convert the existing spike branch (`spike/tldraw-eval`) into the real
canvas. Drop BlockSuite **and** every Affine leftover (styling, theme, Yjs note
maps), drop the document/page view entirely, and stay as close to native tldraw as
possible. This is a *conversion of working spike code*, not a from-scratch build —
no time estimates by design.

**Decisions baked in:** PD-013 (replace, now, at v0) · PD-011 (edgeless is the only
surface — no page view) · drop Affine styling, use tldraw's native **styles system**
· single-user local-first (PD-001), so default persistence is tldraw `persistenceKey`
→ IndexedDB (backend-SQLite is a separate, later ticket).

**References:** `docs/design/tldraw-spike.md` (comparison + rationale) ·
[tldraw styles](https://tldraw.dev/sdk-features/styles).

---

## 0. What the branch already gives us (reuse, don't rebuild)

On `spike/tldraw-eval`, proven working (renders in the shell, survives reload):

- The **React↔Angular bridge** — `tldraw-spike.component.ts` (`createRoot` /
  `unmount`). Becomes the canvas host.
- The **`idea-card` custom shape** (kind/title/body/origin/superseded) + shape
  registration via `TLGlobalShapePropsMap`.
- **Typed edges** — native arrows bound to cards, `relation` in `meta`, styled by
  relation.
- **`applyIdeas` port** — ref resolution → near-target placement → relation edge →
  supersede ghost → AI provenance badge.
- **Kind registry reuse** — imports `kindLabel`/`normalizeKind`/`AI_PROVENANCE_BADGE`
  from `idea-descriptors.ts`.
- **Persistence** via `persistenceKey`.

The conversion is mostly: promote this island into the real `CanvasService` seam,
make it multi-workspace, wire the consumers, strip BlockSuite, and re-style native.

---

## 1. Promote the spike into a tldraw-backed `CanvasService`

Replace the body of `frontend/src/app/core/canvas.service.ts` (the 941-line
BlockSuite impl) with a tldraw-backed one that **keeps the same public method
signatures**, so the four consumers barely change. The React island holds the
`Editor`; `CanvasService` is the Angular-facing facade over it.

Public seam to preserve (all current callers):

| Method | Consumer | tldraw implementation |
| --- | --- | --- |
| `init()` | workspace.service | no-op / set ready (no DocCollection) |
| `mount(host, id)` | canvas-pane | mount React root; load workspace `id`'s store (**drop the `mode` arg**) |
| `switchTo(id)` | workspace.service | swap the active workspace store (**drop `mode`**) — §5 hot-switch |
| `applyIdeas(id, ideas)` | ingestion.service | the ported `applyIdeas` (refs persisted in `shape.meta.ref`) |
| `serializeToText(id)` | agent.service | walk `idea-card` shapes → markdown (kind/title/body) |
| `getSelectedText()` | agent.service | `editor.getSelectedShapes()` → text |
| `kindsPresent(id)` | canvas-pane | distinct `kind` over the store's idea-cards |
| `setKindVisible(id, kind, v)` | canvas-pane | §4 kind filter |
| `onCardVerb(cb)` | canvas-pane | §3 verbs callback |
| `cardRef` / `resolveRef` | (graph) | read/write `shape.meta.ref` |
| `noteOrigin` / `noteKind` / `noteLifecycle` | (graph) | read shape props |
| `removeWorkspace(id)` | workspace.service | delete that workspace's persisted store |
| `dispose()` | app teardown | unmount root, dispose stores |
| `ensureReady(id)` | workspace.service | resolve once the store has loaded |

**Drop entirely** (BlockSuite/page-only): `setDocTitle`, `onDocTitleChanged`,
`#observeTitle`, `setMode`, `knownDocIds`, all seeding (`#seedBlocks`/`canvas-seed`),
the five `ai-storm:*` Y.Maps (now native shape props/meta), `registerEffects`.

**Done when:** ideas stream onto the canvas; selection/serialize/context work; the
file imports no `@blocksuite/*` or `yjs`.

## 2. Drop the document / page view

- `models.ts`: remove `CanvasMode` and the `mode` field from `WorkspaceMeta`.
- `workspace.service.ts`: remove `setMode`, the `mode: 'page'` default, and the
  `mode` arg from `switchTo`. Persisted `mode` values are simply ignored (v0).
- `canvas-pane.component.ts`: delete the Document/Canvas `Tabs` toggle, `activeMode`,
  `onModeChange`, `setMode`, and the tab-panel scaffolding. The pane becomes just the
  toolbar (filters + actions) over the canvas host.
- Title sync goes with it: the workspace title is a sidebar/`WorkspaceService`
  concern only (there is no editor title field anymore).

**Done when:** one surface, no `mode` anywhere, rename still works from the sidebar.

## 3. Card verbs (#13/#15) → tldraw UI

Port `discuss-toolbar.ts` from BlockSuite's edgeless element-toolbar to a tldraw
mechanism: a shape context-menu / selection action that, for a selected `idea-card`,
serializes the card and fires `onCardVerb(text, intent, sourceRef)` — `sourceRef`
read from `shape.meta.ref` (mint lazily via `cardRef`). Reuse `CARD_VERBS` + the
`PromptIntent` framing unchanged.

**Done when:** selecting a card exposes Discuss/Expand/Challenge/Find-risks and they
type a framed prompt into the terminal, with the source ref tagged.

## 4. Kind-filter visibility (#21), tldraw-native

Replace BlockSuite `displayMode` toggling with a tldraw approach: hide cards of a
kind via `opacity`/a render filter (or `updateShapes` opacity 0 + `isLocked`).
`kindsPresent` reads distinct kinds off the store.

**Done when:** the filter chips hide/show cards by kind on the one surface.

## 5. Multi-workspace persistence + hot-switch

- **Persistence:** one tldraw store per workspace, persisted to IndexedDB keyed by
  workspace id (`persistenceKey: 'ai-storm:ws:<id>'`). Local-first; survives reload
  (proven for one store). Refs live in `shape.meta.ref` so identity survives.
- **Hot-switch (PD-006, <100ms):** swap the active workspace store on `switchTo`.
  **Open item:** confirm one-`<Tldraw>`-with-swapped-store vs. remount-per-key hits
  <100ms; pick the faster. (The one perf unknown — verify live.)
- **Crash recovery:** on boot, the last-active workspace's store loads from IDB; no
  seeding (a brainstorm starts empty).

**Done when:** switching workspaces is instant and isolated; reload restores the last
workspace.

## 6. Drop all Affine leftovers; adopt tldraw's native styles system

This is the "as close to native tldraw as possible" step.

- **Remove deps:** `@blocksuite/block-std`, `@blocksuite/blocks`,
  `@blocksuite/presets`, `@blocksuite/store`, `@toeverything/theme`, `y-indexeddb`,
  `yjs` (unless a yjs↔tldraw adapter is later chosen for persistence). Remove
  `allowedCommonJsDependencies` (the BlockSuite lodash entries) from `angular.json`.
- **Styling via tldraw `StyleProp`, not Affine hex.** Delete the `KIND_TINT`
  Affine-hex map. Make the card's color a real tldraw shared style so it participates
  in the **style panel**, remembers last-used, persists, and resolves to **light/dark
  theme** automatically (the whole point of the styles system):

  ```ts
  import { DefaultColorStyle, type RecordProps } from 'tldraw'

  // idea-card props: `color` becomes a shared StyleProp (was a hardcoded tint).
  const props: RecordProps<IdeaCardShape> = {
    w: T.number, h: T.number,
    kind: T.string, title: T.string, body: T.string,
    origin: T.literalEnum('ai', 'user'),
    superseded: T.boolean,
    color: DefaultColorStyle, // tldraw palette name ('red' | 'green' | …)
  }
  ```

  - **Kind → tldraw color** (set when `applyIdeas` creates the card): risk→`red`,
    feature→`green`, question→`yellow`, decision→`blue`, todo→`light-blue`,
    heuristic→`violet`. The user can still recolor via the native style panel; `kind`
    (+ the `kindLabel` badge) stays the semantic source of truth.
  - **Render** the card from the resolved theme color rather than a literal hex, so
    it tracks light/dark (tldraw's color theme for the shape's `color` style;
    confirm the exact resolver export for our tldraw version — top-level theme
    helpers churned across majors). Superseded ghost uses the muted/`grey` theme
    entry + a dashed border.
  - Edges already use tldraw palette names (`grey`/`red`) — keep.
- **Registry shape:** `KindSpec.background` currently holds an `--affine-note-*`
  string. Replace it with a tldraw color-style name (e.g. `color: 'red'`), or drop
  `background` from the shared `KindSpec` and keep a small kind→tldraw-color map on
  the canvas side. `kindLabel` and the kind set are unchanged.

**Done when:** no `affine`/`blocksuite`/`toeverything` reference remains in
`frontend/`; the bundle no longer carries BlockSuite; cards use tldraw's style panel
and follow its light/dark themes.

## 7. Tests

- Update `workspace.service.test.ts` — its `CanvasService` mock loses
  `setDocTitle`/`onDocTitleChanged`/`mode`; assert rename via the sidebar path only.
- `ingestion.service.test.ts` — `applyIdeas` mock unchanged in shape.
- Delete `canvas-seed.ts` + `canvas-seed.test.ts` (no seeding).
- Keep `idea-descriptors.test.ts`, `markdown-block-parser`, `prompt-framing.test.ts`,
  `render-scheduler` (all reused).
- Add a unit test for the new `serializeToText`/`getSelectedText` shape walk.

## 8. Live verification (replaces the spike's `spike-verify.mjs`)

1. New workspace → start session → stream `«IDEA…@ref!»` → cards + edges land,
   linked, with kind colors + 🤖 badges.
2. Fire a card verb → framed prompt enters the terminal with `@ref`.
3. Challenge → refined card supersedes target → target ghosts.
4. Kind filter hides/shows.
5. Hot-switch between two workspaces (<100ms) → isolated; reload → restored.
6. Re-check #38 (terminal-resize duplicates notes) — may vanish or reappear on the
   new canvas; trace if it persists.

## 9. Cleanup of spike scaffolding

- Remove the `?spike=tldraw` `@defer` toggle in `app.component.ts`; the tldraw canvas
  is now *the* canvas in `canvas-pane`.
- Fold `tldraw-canvas.tsx` / `tldraw-spike.component.ts` into the real `core/` canvas
  module; drop the seed/demo `SEED_IDEAS` + `spike-verify.mjs`.

---

## Sequencing vs #42

The shared `Idea` / `IdeaRelation` / `IdeaLink` types and the `«IDEA…@ref!»`
extraction contract are **framework-neutral and port verbatim** — unchanged by this
migration. Land/stabilize #42's model first; this conversion then swaps only the
rendering + persistence layer beneath it. Consumers (`ingestion`, `agent`,
`workspace`) keep their `CanvasService` call sites; only `CanvasService`'s internals
and the page-view plumbing change.

## Open decisions

1. **Hot-switch mechanism** (§5) — verify the <100ms approach live.
2. **Theme-color resolver** (§6) — confirm the exact tldraw API to resolve a
   `DefaultColorStyle` value → hex for the HTML card body in our pinned tldraw
   version (the top-level theme helpers shifted across majors).
3. **Persistence model** — default tldraw `persistenceKey` (this plan). A yjs↔tldraw
   adapter (keep CRDT) or backend-SQLite snapshot store (the ticket's musing) are
   alternatives to decide explicitly if/when multiplayer or server storage returns.
