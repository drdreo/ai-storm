import {
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import { useState } from "react";
import type { Folder, WorkspaceMeta } from "@ai-storm/shared";
import { computeOrder, orderAfterAll } from "../../core/sidebar-order";
import { workspace } from "../../stores/workspace.store";

/** Droppable id for the top-level (ungrouped) zone when it has no rows. */
export const UNGROUPED_ZONE = "__ungrouped__";

export type DragKind = "workspace" | "folder";

/**
 * Sidebar drag-and-drop (#128): reorder folders among folders, reorder
 * workspaces within a container, or drag a workspace across containers
 * (folder ↔ top level). Wraps dnd-kit's sensors + drag-end math so
 * {@link Sidebar} only wires up `DndContext`/`SortableContext` markup.
 */
export function useSidebarDnd(workspaces: WorkspaceMeta[], folders: Folder[]) {
  const [drag, setDrag] = useState<{ kind: DragKind; id: string } | null>(null);

  // Distance threshold keeps plain click (activate) and double-click (rename)
  // working on rows that are also pointer drag sources. Pointer-only: rows are
  // themselves the drag source, so there's no dedicated keyboard-focusable
  // handle for a KeyboardSensor to attach to.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  /** A workspace's effective container: its folder id, or null (top level). */
  const containerOf = (ws: WorkspaceMeta): string | null =>
    ws.folderId && folders.some((f) => f.id === ws.folderId) ? ws.folderId : null;

  const onDragStart = (e: DragStartEvent) => {
    const kind = e.active.data.current?.kind as DragKind | undefined;
    setDrag(kind ? { kind, id: String(e.active.id) } : null);
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDrag(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const overId = String(over.id);

    if (active.data.current?.kind === "folder") {
      const folderId = String(active.id);
      // Folders only reorder among folders: a workspace target maps to its
      // containing folder; an ungrouped target means "past the last folder".
      const overWs = workspaces.find((w) => w.id === overId);
      const targetId = folders.some((f) => f.id === overId) ? overId : overWs ? containerOf(overWs) : null;
      if (targetId === folderId) return;
      const siblings = folders.filter((f) => f.id !== folderId);
      const order = targetId
        ? computeOrder(
            siblings,
            folders.findIndex((f) => f.id === targetId)
          )
        : orderAfterAll(siblings);
      workspace.reorderFolder(folderId, order);
      return;
    }

    // Workspace drag: within a container, into a folder, or back to top level.
    const wsId = String(active.id);
    const appendTo = (container: string | null) => {
      const siblings = workspaces.filter((w) => containerOf(w) === container && w.id !== wsId);
      workspace.moveWorkspace(wsId, container, orderAfterAll(siblings));
    };

    if (overId === UNGROUPED_ZONE) return appendTo(null);
    if (folders.some((f) => f.id === overId)) return appendTo(overId);

    const overWs = workspaces.find((w) => w.id === overId);
    const activeWs = workspaces.find((w) => w.id === wsId);
    if (!overWs || !activeWs) return;
    const target = containerOf(overWs);
    const items = workspaces.filter((w) => containerOf(w) === target);
    const siblings = items.filter((w) => w.id !== wsId);
    // Same container follows arrayMove semantics (the index of the hovered row
    // in the full list is where the moved row lands once its old slot closes);
    // cross-container inserts before the hovered row.
    const dropIndex =
      containerOf(activeWs) === target
        ? items.findIndex((w) => w.id === overId)
        : siblings.findIndex((w) => w.id === overId);
    workspace.moveWorkspace(wsId, target, computeOrder(siblings, dropIndex));
  };

  return {
    sensors,
    collisionDetection: closestCenter,
    drag,
    onDragStart,
    onDragEnd,
    onDragCancel: () => setDrag(null),
    containerOf,
    draggedWs: drag?.kind === "workspace" ? workspaces.find((w) => w.id === drag.id) : undefined,
    draggedFolder: drag?.kind === "folder" ? folders.find((f) => f.id === drag.id) : undefined
  };
}
