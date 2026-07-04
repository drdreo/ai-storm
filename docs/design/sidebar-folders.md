# Design: sidebar folders & drag-and-drop ordering

**Status:** 🟢 Implemented
**Author:** ai-storm
**Related:** [Product decisions](../decisions/product-decisions.md) PRD §3.4 (sidebar) · issue #128

---

## 1. Problem

The sidebar lists every workspace flat, ordered by `createdAt`. That's fine for a handful of
projects but doesn't scale: users running several concurrent brainstorms have no way to group
related ones or control the order they appear in.

## 2. Goal

Let users organize the sidebar themselves:

- **Folders** — named containers that group workspaces. Pure organizational containers: no
  canvas or session state of their own, so deleting a folder never deletes its workspaces.
- **Ordering** — drag to reorder folders, reorder workspaces within a container, and move a
  workspace between containers (folder ↔ top level). Keyboard-accessible, not just mouse.

## 3. Data model

`WorkspaceMeta.folderId?: string` — undefined means top-level. `Folder { id, title, collapsed? }`
is a separate CRDT map entry; folders hold no reference to their children (derived by filtering
workspaces on `folderId`).

Both `WorkspaceMeta` and `Folder` carry an `order?: string` — a **fractional-index** key
([`fractional-indexing`](https://www.npmjs.com/package/fractional-indexing)) ranking the item
among its siblings (a workspace's siblings are the others in the same container; a folder's
siblings are all folders). Inserting between two neighbors only ever writes the moved item's key,
which keeps CRDT merge conflicts minimal — no renormalization pass needed, since fractional keys
never exhaust the gap between two neighbors.

Sort order is `order` ascending, falling back to `createdAt` for items with no key (pre-feature
data) or an exact tie (possible after a concurrent write merges two identical keys). A one-time
boot pass re-keys any registry that predates this feature so every later insert can assume keyed
neighbors.

## 4. UI

- Folders render above ungrouped workspaces, collapsible, with a rename/delete kebab. Deleting a
  folder keeps its workspaces — they fall back to the top level.
- The existing "Move to folder" menu item still works (appends to the target container).
- Drag-and-drop ([`@dnd-kit`](https://dndkit.com/)) adds three interactions on top: reorder
  folders among folders, reorder workspaces within a container, and drag a workspace across
  containers (including a dedicated drop zone to ungroup when the top level is empty). A grip
  handle carries the keyboard interaction (space to lift, arrows to move, space to drop) separate
  from the row's own click-to-activate / double-click-to-rename.

## 5. Non-goals

- Nested folders (folders are a single flat level).
- Multi-select / bulk move.

## 6. Alternatives considered

Float-midpoint ordering (`(prev + next) / 2`, renormalize on collision) was the original plan —
zero extra dependency, but needs an occasional multi-item rewrite when floats run out of
precision, which works against the CRDT goal of only writing the moved item. `fractional-indexing`
(~1 KB) avoids that entirely, so it won out despite the added dependency.
