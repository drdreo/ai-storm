import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Sidebar as UISidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarRail
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  GripVertical,
  MoreHorizontal,
  Plus,
  Settings,
  Upload
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { Folder, WorkspaceMeta, WorkspaceStatus } from "@ai-storm/shared";
import { downloadFile } from "../core/download-file";
import { defaultWorkspaceColor, WORKSPACE_COLORS } from "../core/models";
import { computeOrder, orderAfterAll } from "../core/sidebar-order";
import { exportFileSlug, parseExportBundle } from "../core/workspace-portable";
import { ingestion } from "../stores/ingestion.store";
import { ui, useUiStore } from "../stores/ui.store";
import { useWorkspaceStore, workspace } from "../stores/workspace.store";
import { SettingsDialog } from "./SettingsDialog";

/** Hover explanation for the workspace status badge (the ringed accent dot). */
const STATUS_HINT: Record<WorkspaceStatus, string> = {
  idle: "No session running",
  active: "Session live",
  streaming: "Session live — agent responding",
  error: "Session error — open the workspace for details"
};

/** Droppable id for the top-level (ungrouped) zone when it has no rows. */
const UNGROUPED_ZONE = "__ungrouped__";

type DragKind = "workspace" | "folder";

/** The workspace status/accent dot, shared by the row and the drag overlay. */
function StatusDot({ ws }: { ws: WorkspaceMeta }) {
  const accent = ws.color ?? defaultWorkspaceColor(ws.id);
  return (
    <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
      <span
        className={cn(
          "size-2.5",
          ws.status === "error" ? "rounded-[2px] bg-destructive" : "rounded-full",
          ws.status === "active" && "ring-2 ring-emerald-500 ring-offset-2 ring-offset-sidebar",
          ws.status === "streaming" && "ring-2 ring-sky-500 ring-offset-2 ring-offset-sidebar animate-pulse"
        )}
        style={ws.status === "error" ? undefined : { backgroundColor: accent }}
      />
    </span>
  );
}

interface WorkspaceRowProps {
  ws: WorkspaceMeta;
  isActive: boolean;
  isEditing: boolean;
  folders: Folder[];
  onStartRename: (id: string) => void;
  onCommitRename: (ws: WorkspaceMeta, value: string) => void;
  onRenameKey: (e: React.KeyboardEvent<HTMLInputElement>, ws: WorkspaceMeta) => void;
  renameInputRef: (el: HTMLInputElement | null) => void;
  onRequestDelete: (ws: WorkspaceMeta) => void;
  onExport: (ws: WorkspaceMeta) => void;
}

/**
 * A single sortable workspace row (status dot, inline rename, kebab). Shared
 * between the top-level list and the rows nested inside a folder group.
 *
 * Drag ergonomics (#128 DnD): the whole row is a pointer drag source (with a
 * small distance threshold so click/double-click still activate/rename), while
 * a dedicated grip button carries the keyboard + screen-reader drag interaction
 * — putting dnd-kit's key listeners on the row itself would steal Enter/Space
 * from "activate workspace".
 */
function SortableWorkspaceRow(props: WorkspaceRowProps) {
  const { ws, isActive, isEditing, folders } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ws.id,
    data: { kind: "workspace" satisfies DragKind },
    disabled: isEditing
  });
  const style: React.CSSProperties = { transform: CSS.Translate.toString(transform), transition };

  if (isEditing) {
    return (
      <SidebarMenuItem>
        <SidebarInput
          ref={props.renameInputRef}
          defaultValue={ws.title}
          aria-label="Rename workspace"
          onKeyDown={(e) => props.onRenameKey(e, ws)}
          onBlur={(e) => props.onCommitRename(ws, e.currentTarget.value)}
        />
      </SidebarMenuItem>
    );
  }

  const accent = ws.color ?? defaultWorkspaceColor(ws.id);
  return (
    <SidebarMenuItem ref={setNodeRef} style={style} className={cn(isDragging && "opacity-40")}>
      <SidebarMenuButton
        isActive={isActive}
        onClick={() => workspace.setActive(ws.id)}
        onDoubleClick={() => props.onStartRename(ws.id)}
        onPointerDown={listeners?.onPointerDown as React.PointerEventHandler<HTMLButtonElement> | undefined}
        tooltip={ws.status === "idle" ? ws.title : `${ws.title} · ${STATUS_HINT[ws.status]}`}
      >
        <StatusDot ws={ws} />
        <span className="truncate">{ws.title}</span>
        <span className="sr-only">— {ws.status}</span>
      </SidebarMenuButton>

      <SidebarMenuAction
        showOnHover
        className="right-6 cursor-grab text-muted-foreground active:cursor-grabbing"
        aria-label={`Reorder ${ws.title}`}
        {...attributes}
        {...listeners}
      >
        <GripVertical />
      </SidebarMenuAction>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction showOnHover aria-label={`Manage ${ws.title}`}>
            <MoreHorizontal />
          </SidebarMenuAction>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="min-w-[156px]">
          <DropdownMenuItem onSelect={() => props.onStartRename(ws.id)}>Rename</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Color</DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="min-w-0 p-2">
                <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="Workspace color">
                  {WORKSPACE_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Set color ${c}`}
                      aria-pressed={accent === c}
                      onClick={() => workspace.setColor(ws.id, c)}
                      className={cn(
                        "size-5 rounded-full ring-offset-2 ring-offset-popover transition-shadow",
                        accent === c && "ring-2 ring-foreground"
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Move to folder</DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="min-w-[156px]">
                <DropdownMenuItem onSelect={() => workspace.moveToFolder(ws.id, null)}>
                  {!ws.folderId && <Check className="size-3.5" />}
                  <span className={cn(!ws.folderId && "font-medium")}>No folder</span>
                </DropdownMenuItem>
                {folders.length > 0 && <DropdownMenuSeparator />}
                {folders.map((f) => (
                  <DropdownMenuItem key={f.id} onSelect={() => workspace.moveToFolder(ws.id, f.id)}>
                    {ws.folderId === f.id && <Check className="size-3.5" />}
                    <span className={cn("truncate", ws.folderId === f.id && "font-medium")}>{f.title}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={() => props.onExport(ws)}>Export</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => props.onRequestDelete(ws)}>
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  );
}

interface FolderGroupProps {
  folder: Folder;
  isEditing: boolean;
  childIds: string[];
  children: React.ReactNode;
  onStartRename: (id: string) => void;
  onCommitRename: (folder: Folder, value: string) => void;
  onRenameKey: (e: React.KeyboardEvent<HTMLInputElement>, folder: Folder) => void;
  renameInputRef: (el: HTMLInputElement | null) => void;
  onRequestDelete: (folder: Folder) => void;
}

/**
 * A sortable, collapsible folder group with its own rename/delete kebab.
 * Collapse state is persisted on the folder meta so it survives a reload
 * (#128). The header doubles as the drop target for moving a workspace into
 * the folder (works while collapsed too); its children form a nested sortable
 * zone. Same drag split as workspace rows: pointer on the header, keyboard via
 * the grip.
 */
function SortableFolderGroup(props: FolderGroupProps) {
  const { folder, isEditing, childIds } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver, active } = useSortable({
    id: folder.id,
    data: { kind: "folder" satisfies DragKind },
    disabled: isEditing
  });
  const style: React.CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  // Highlight the header as a drop target only when a *workspace* hovers it —
  // a hovering folder is just a reorder, not a drop-into.
  const isDropTarget = isOver && active?.data.current?.kind === "workspace";

  return (
    <Collapsible
      open={!folder.collapsed}
      onOpenChange={(open) => workspace.setFolderCollapsed(folder.id, !open)}
      className="group/folder"
      asChild
    >
      <SidebarMenuItem ref={setNodeRef} style={style} className={cn(isDragging && "opacity-40")}>
        {isEditing ? (
          <SidebarInput
            ref={props.renameInputRef}
            defaultValue={folder.title}
            aria-label="Rename folder"
            onKeyDown={(e) => props.onRenameKey(e, folder)}
            onBlur={(e) => props.onCommitRename(folder, e.currentTarget.value)}
          />
        ) : (
          <>
            <CollapsibleTrigger asChild>
              <SidebarMenuButton
                onDoubleClick={() => props.onStartRename(folder.id)}
                onPointerDown={listeners?.onPointerDown as React.PointerEventHandler<HTMLButtonElement> | undefined}
                tooltip={folder.title}
                className={cn(isDropTarget && "ring-2 ring-sidebar-ring bg-sidebar-accent")}
              >
                <ChevronRight className="size-4 shrink-0 transition-transform group-data-[state=open]/folder:rotate-90" />
                <FolderIcon className="size-4 shrink-0" />
                <span className="truncate">{folder.title}</span>
                <span className="ml-auto text-xs text-muted-foreground">{childIds.length || ""}</span>
              </SidebarMenuButton>
            </CollapsibleTrigger>

            <SidebarMenuAction
              showOnHover
              className="right-6 cursor-grab text-muted-foreground active:cursor-grabbing"
              aria-label={`Reorder folder ${folder.title}`}
              {...attributes}
              {...listeners}
            >
              <GripVertical />
            </SidebarMenuAction>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuAction showOnHover aria-label={`Manage folder ${folder.title}`}>
                  <MoreHorizontal />
                </SidebarMenuAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" className="min-w-[156px]">
                <DropdownMenuItem onSelect={() => props.onStartRename(folder.id)}>Rename</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => props.onRequestDelete(folder)}>
                  Delete folder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}

        <CollapsibleContent>
          <SidebarMenuSub className="mr-0 pr-0">
            <SortableContext items={childIds} strategy={verticalListSortingStrategy}>
              {childIds.length > 0 ? (
                props.children
              ) : (
                <li className="px-2 py-1 text-xs text-muted-foreground">Empty — move a workspace here.</li>
              )}
            </SortableContext>
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/**
 * Catch area for dragging a workspace back to the top level when no ungrouped
 * rows exist to drop next to (only rendered mid-drag in that state).
 */
function UngroupedDropZone() {
  const { setNodeRef, isOver } = useDroppable({ id: UNGROUPED_ZONE });
  return (
    <li
      ref={setNodeRef}
      className={cn(
        "mx-2 my-1 rounded-md border border-dashed border-sidebar-border px-2 py-2 text-xs text-muted-foreground",
        isOver && "border-sidebar-ring bg-sidebar-accent"
      )}
    >
      Drop here to ungroup
    </li>
  );
}

/**
 * Global navigation sidebar (PRD §3.4), built on shadcn's app-sidebar
 * composition: an inset, icon-collapsible Sidebar with a branded header, a
 * collapsible "Workspaces" group whose action (+) creates a workspace, a rail
 * toggle, and a settings footer. Entries are stock
 * SidebarMenuButtons (default styling + the built-in active indicator). The
 * per-row kebab is a Radix DropdownMenu; rename is an inline input.
 *
 * Ordering is user-controlled via drag & drop (#128): folders sort among
 * folders, workspaces sort within and across containers (folder ↔ top level),
 * persisted as fractional-index keys on the registry CRDT.
 */
export function Sidebar() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const folders = useWorkspaceStore((s) => s.folders);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceMeta | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<Folder | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ kind: DragKind; id: string } | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Distance threshold keeps plain click (activate) and double-click (rename)
  // working on rows that are also pointer drag sources.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  /**
   * Focus (and select) the freshly-rendered inline rename input. Deferred a
   * frame: when the rename starts from a Radix menu, the menu's focus scope is
   * still tearing down at mount time and would immediately steal focus back.
   */
  const renameInputRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      requestAnimationFrame(() => {
        if (el.isConnected) {
          el.focus();
          el.select();
        }
      });
    }
  }, []);

  // "New folder" mounts the inline rename input focused, but the Radix menu
  // closing afterwards would return focus to its trigger, stealing it from the
  // input. Suppress that focus return for the close that follows the action.
  const keepRenameFocusRef = useRef(false);
  const onNewMenuCloseAutoFocus = (e: Event) => {
    if (keepRenameFocusRef.current) {
      keepRenameFocusRef.current = false;
      e.preventDefault();
    }
  };

  const add = () => {
    const id = workspace.create("Untitled Project");
    workspace.setActive(id);
  };

  const addFolder = () => {
    keepRenameFocusRef.current = true;
    setEditingId(workspace.createFolder("New Folder"));
  };

  const commitRename = (ws: WorkspaceMeta, value: string) => {
    if (editingId !== ws.id) return;
    const title = value.trim();
    if (title && title !== ws.title) workspace.rename(ws.id, title);
    setEditingId(null);
  };

  const onRenameKey = (e: React.KeyboardEvent<HTMLInputElement>, ws: WorkspaceMeta) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename(ws, e.currentTarget.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditingId(null);
    }
  };

  const commitFolderRename = (folder: Folder, value: string) => {
    if (editingId !== folder.id) return;
    const title = value.trim();
    if (title && title !== folder.title) workspace.renameFolder(folder.id, title);
    setEditingId(null);
  };

  const onFolderRenameKey = (e: React.KeyboardEvent<HTMLInputElement>, folder: Folder) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitFolderRename(folder, e.currentTarget.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditingId(null);
    }
  };

  // Deleting a workspace drops its canvas + IndexedDB store for good, so the
  // kebab only *requests* deletion (opens a themed confirm dialog, audit H5);
  // the irreversible work runs on explicit confirm, never on window.confirm.
  const confirmDelete = () => {
    if (!deleteTarget) return;
    ingestion.detach(deleteTarget.id);
    void workspace.remove(deleteTarget.id);
    setDeleteTarget(null);
  };

  // Deleting a folder only drops the container — its workspaces (and their
  // canvases) survive, falling back to the sidebar's top level.
  const confirmDeleteFolder = () => {
    if (!deleteFolderTarget) return;
    workspace.removeFolder(deleteFolderTarget.id);
    setDeleteFolderTarget(null);
  };

  // Export switches onto the target workspace first (a live editor is needed to
  // read the board), then downloads its portable JSON bundle (#105).
  const exportWorkspace = async (ws: WorkspaceMeta) => {
    const bundle = await workspace.exportBundle(ws.id);
    if (!bundle) return;
    downloadFile(`${exportFileSlug(ws.title)}-workspace.json`, JSON.stringify(bundle, null, 2), "application/json");
  };

  const importWorkspace = () => importInputRef.current?.click();

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const bundle = parseExportBundle(await file.text());
      await workspace.importBundle(bundle);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed.");
    }
  };

  // ---- Drag & drop (#128) ---------------------------------------------------

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

  const renderRow = (ws: WorkspaceMeta) => (
    <SortableWorkspaceRow
      key={ws.id}
      ws={ws}
      isActive={ws.id === activeId}
      isEditing={editingId === ws.id}
      folders={folders}
      onStartRename={setEditingId}
      onCommitRename={commitRename}
      onRenameKey={onRenameKey}
      renameInputRef={renameInputRef}
      onRequestDelete={setDeleteTarget}
      onExport={(ws) => void exportWorkspace(ws)}
    />
  );

  const ungrouped = workspaces.filter((w) => containerOf(w) === null);
  const draggedWs = drag?.kind === "workspace" ? workspaces.find((w) => w.id === drag.id) : undefined;
  const draggedFolder = drag?.kind === "folder" ? folders.find((f) => f.id === drag.id) : undefined;

  return (
    <UISidebar variant="inset" collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Presentational brand mark — not interactive, so render as a div
                (audit H4): a real <button> with no action is a confusing focus
                stop and a false button role for screen readers. */}
            <SidebarMenuButton asChild size="lg" className="cursor-default hover:bg-transparent">
              <div>
                <img src="/assets/logo.png" alt="" className="size-8 rounded-lg" />
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">ai-storm</span>
                  <span className="truncate text-xs text-muted-foreground">brainstorm workspace</span>
                </div>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <Collapsible defaultOpen className="group/collapsible">
          <SidebarGroup>
            <SidebarGroupLabel asChild>
              <CollapsibleTrigger className="w-full">
                Workspaces
                <ChevronDown className="ml-1 size-3.5 transition-transform group-data-[state=closed]/collapsible:-rotate-90" />
              </CollapsibleTrigger>
            </SidebarGroupLabel>
            <SidebarGroupAction
              title="Import workspace"
              aria-label="Import workspace"
              onClick={importWorkspace}
              className="right-7"
            >
              <Upload /> <span className="sr-only">Import workspace</span>
            </SidebarGroupAction>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => void onImportFile(e)}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarGroupAction title="New…" aria-label="New workspace or folder">
                  <Plus /> <span className="sr-only">New workspace or folder</span>
                </SidebarGroupAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="right"
                align="start"
                className="min-w-[156px]"
                onCloseAutoFocus={onNewMenuCloseAutoFocus}
              >
                <DropdownMenuItem onSelect={add}>
                  <Plus className="size-4" /> New workspace
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={addFolder}>
                  <FolderPlus className="size-4" /> New folder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <CollapsibleContent>
              <SidebarGroupContent>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  modifiers={[restrictToVerticalAxis]}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  onDragCancel={() => setDrag(null)}
                >
                  <SidebarMenu>
                    <SortableContext items={folders.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                      {folders.map((folder) => {
                        const children = workspaces.filter((w) => w.folderId === folder.id);
                        return (
                          <SortableFolderGroup
                            key={folder.id}
                            folder={folder}
                            isEditing={editingId === folder.id}
                            childIds={children.map((c) => c.id)}
                            onStartRename={setEditingId}
                            onCommitRename={commitFolderRename}
                            onRenameKey={onFolderRenameKey}
                            renameInputRef={renameInputRef}
                            onRequestDelete={setDeleteFolderTarget}
                          >
                            {children.map(renderRow)}
                          </SortableFolderGroup>
                        );
                      })}
                    </SortableContext>
                    <SortableContext items={ungrouped.map((w) => w.id)} strategy={verticalListSortingStrategy}>
                      {ungrouped.map(renderRow)}
                      {ungrouped.length === 0 && drag?.kind === "workspace" && <UngroupedDropZone />}
                    </SortableContext>
                  </SidebarMenu>

                  <DragOverlay>
                    {draggedWs ? (
                      <div className="flex items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-sm text-sidebar-accent-foreground shadow-md">
                        <StatusDot ws={draggedWs} />
                        <span className="truncate">{draggedWs.title}</span>
                      </div>
                    ) : draggedFolder ? (
                      <div className="flex items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-sm text-sidebar-accent-foreground shadow-md">
                        <FolderIcon className="size-4 shrink-0" />
                        <span className="truncate">{draggedFolder.title}</span>
                      </div>
                    ) : null}
                  </DragOverlay>
                </DndContext>
              </SidebarGroupContent>
            </CollapsibleContent>
          </SidebarGroup>
        </Collapsible>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" onClick={() => ui.openSettings()} tooltip="Settings">
              <Settings className="size-4" />
              <span className="truncate text-xs">Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SettingsDialog open={settingsOpen} onOpenChange={ui.setSettingsOpen} />

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete workspace?</DialogTitle>
            <DialogDescription>
              “{deleteTarget?.title}” and its canvas will be permanently deleted. This can’t be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" size="sm" onClick={confirmDelete}>
              Delete workspace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteFolderTarget} onOpenChange={(open) => !open && setDeleteFolderTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete folder?</DialogTitle>
            <DialogDescription>
              “{deleteFolderTarget?.title}” will be removed. Its workspaces are kept and moved back to the top level.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" size="sm" onClick={confirmDeleteFolder}>
              Delete folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!importError} onOpenChange={(open) => !open && setImportError(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Import failed</DialogTitle>
            <DialogDescription>{importError}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Close
              </Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SidebarRail />
    </UISidebar>
  );
}
