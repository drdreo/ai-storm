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
  Check,
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  MoreHorizontal,
  Plus,
  Settings,
  Upload
} from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { Folder, WorkspaceMeta, WorkspaceStatus } from "@ai-storm/shared";
import { downloadFile } from "../core/download-file";
import { defaultWorkspaceColor, WORKSPACE_COLORS } from "../core/models";
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

/**
 * Global navigation sidebar (PRD §3.4), built on shadcn's app-sidebar
 * composition: an inset, icon-collapsible Sidebar with a branded header, a
 * collapsible "Workspaces" group whose action (+) creates a workspace, a rail
 * toggle, and a settings footer. Entries are stock
 * SidebarMenuButtons (default styling + the built-in active indicator). The
 * per-row kebab is a Radix DropdownMenu; rename is an inline input.
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
  const importInputRef = useRef<HTMLInputElement>(null);

  /** Focus (and select) the freshly-rendered inline rename input. */
  const renameInputRef = useCallback((el: HTMLInputElement | null) => {
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  const add = () => {
    const id = workspace.create("Untitled Project");
    workspace.setActive(id);
  };

  const addFolder = () => setEditingId(workspace.createFolder("New Folder"));

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

  // A single workspace row (status dot, inline rename, kebab). Shared between the
  // top-level list and the workspaces nested inside a folder group.
  const renderWorkspaceRow = (ws: WorkspaceMeta) => {
    const isActive = ws.id === activeId;
    const accent = ws.color ?? defaultWorkspaceColor(ws.id);
    if (editingId === ws.id) {
      return (
        <SidebarMenuItem key={ws.id}>
          <SidebarInput
            ref={renameInputRef}
            defaultValue={ws.title}
            aria-label="Rename workspace"
            onKeyDown={(e) => onRenameKey(e, ws)}
            onBlur={(e) => commitRename(ws, e.currentTarget.value)}
          />
        </SidebarMenuItem>
      );
    }
    return (
      <SidebarMenuItem key={ws.id}>
        <SidebarMenuButton
          isActive={isActive}
          onClick={() => workspace.setActive(ws.id)}
          onDoubleClick={() => setEditingId(ws.id)}
          tooltip={ws.status === "idle" ? ws.title : `${ws.title} · ${STATUS_HINT[ws.status]}`}
        >
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

          <span className="truncate">{ws.title}</span>
          <span className="sr-only">— {ws.status}</span>
        </SidebarMenuButton>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuAction showOnHover aria-label={`Manage ${ws.title}`}>
              <MoreHorizontal />
            </SidebarMenuAction>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="start" className="min-w-[156px]">
            <DropdownMenuItem onSelect={() => setEditingId(ws.id)}>Rename</DropdownMenuItem>
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
            <DropdownMenuItem onSelect={() => void exportWorkspace(ws)}>Export</DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget(ws)}>
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    );
  };

  // A collapsible folder group with its own rename/delete kebab. Collapse state
  // is persisted on the folder meta so it survives a reload (#128).
  const renderFolderGroup = (folder: Folder) => {
    const children = workspaces.filter((w) => w.folderId === folder.id);
    return (
      <Collapsible
        key={folder.id}
        open={!folder.collapsed}
        onOpenChange={(open) => workspace.setFolderCollapsed(folder.id, !open)}
        className="group/folder"
        asChild
      >
        <SidebarMenuItem>
          {editingId === folder.id ? (
            <SidebarInput
              ref={renameInputRef}
              defaultValue={folder.title}
              aria-label="Rename folder"
              onKeyDown={(e) => onFolderRenameKey(e, folder)}
              onBlur={(e) => commitFolderRename(folder, e.currentTarget.value)}
            />
          ) : (
            <>
              <CollapsibleTrigger asChild>
                <SidebarMenuButton onDoubleClick={() => setEditingId(folder.id)} tooltip={folder.title}>
                  <ChevronRight className="size-4 shrink-0 transition-transform group-data-[state=open]/folder:rotate-90" />
                  <FolderIcon className="size-4 shrink-0" />
                  <span className="truncate">{folder.title}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{children.length || ""}</span>
                </SidebarMenuButton>
              </CollapsibleTrigger>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuAction showOnHover aria-label={`Manage folder ${folder.title}`}>
                    <MoreHorizontal />
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="right" align="start" className="min-w-[156px]">
                  <DropdownMenuItem onSelect={() => setEditingId(folder.id)}>Rename</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleteFolderTarget(folder)}>
                    Delete folder
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )}

          <CollapsibleContent>
            <SidebarMenuSub className="mr-0 pr-0">
              {children.length > 0 ? (
                children.map(renderWorkspaceRow)
              ) : (
                <li className="px-2 py-1 text-xs text-muted-foreground">Empty — move a workspace here.</li>
              )}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    );
  };

  const ungrouped = workspaces.filter((w) => !w.folderId || !folders.some((f) => f.id === w.folderId));

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
              <DropdownMenuContent side="right" align="start" className="min-w-[156px]">
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
                <SidebarMenu>
                  {folders.map(renderFolderGroup)}
                  {ungrouped.map(renderWorkspaceRow)}
                </SidebarMenu>
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
