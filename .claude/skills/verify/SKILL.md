---
name: verify
description: Launch and drive ai-storm's frontend to verify canvas/UI changes live (build, seed cards via window.__editor, drive menus with chrome-devtools MCP).
---

# Verifying ai-storm UI changes live

## Launch

- Frontend alone is enough for canvas work — projects are local-first (Y.Doc + IndexedDB + localStorage), no backend needed. The control hub just shows "backend offline"-ish idle state.
- `pnpm --filter ai-storm-frontend dev` → Vite on **http://localhost:4200/**.
- Backend (only for session/PTY flows): `pnpm dev:backend` on :8787 — see memory `windows-watch-nodepty` (never bare `node --watch`).

## Drive

- Open with the chrome-devtools MCP tools; `resize_page` to ~1680×950 first (default window is oddly tall and the canvas pane gets narrow).
- **`window.__editor`** is the mounted project's live tldraw `Editor` (debug hook in `canvas-island.tsx` onMount). Use it to seed test data no UI path can create, e.g. AI-triaged cards:
  ```js
  window.__editor.createShapes([
    {
      type: "idea-card",
      x: 100,
      y: 100,
      props: { w: 250, h: 132, kind: "feature", title: "T", body: "B", origin: "ai", superseded: false, color: "blue" },
      meta: { ref: "a1", score: { impact: 5, effort: 1, confidence: 5 } }
    }
  ]);
  ```
- Canvas main menu = the tldraw ☰ ("Menu" button next to "Page 1"), which holds the Arrange / Filter submenus. The command palette is the "Commands" toolbar button; its cmdk listbox is invisible to a11y snapshots — find items via `document.querySelectorAll('[cmdk-item]')` and dispatch pointerdown/up + click.
- Theme flip for legibility checks: `window.__editor.user.updateUserPreferences({ colorScheme: "light" })`.

## Gotchas

- tldraw menu checkbox items (`TldrawUiMenuCheckboxItem`) expose an empty a11y name — locate them by position within the submenu snapshot, not by label.
- Vite HMR resets per-editor module state (WeakMap atoms, e.g. the priority-grid overlay) — re-trigger the mode through the UI after an edit.
- `zoomToFit` fits shapes only, not on-canvas overlays.
