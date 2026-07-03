import { useCallback, useRef, useState } from "react";
import { Plus, MoreHorizontal, ChevronDown, Settings, Upload } from "lucide-react";
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
  SidebarRail,
  useSidebar
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuPortal,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useWorkspaceStore, workspace } from "../stores/workspace.store";
import { ingestion } from "../stores/ingestion.store";
import { useUiStore, ui } from "../stores/ui.store";
import { SettingsDialog } from "./SettingsDialog";
import { WORKSPACE_COLORS, defaultWorkspaceColor, type WorkspaceMeta, type WorkspaceStatus } from "../core/models";
import { downloadFile } from "../core/download-file";
import { exportFileSlug, parseExportBundle } from "../core/workspace-portable";

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
  const { state: sidebarState } = useSidebar();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeId);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkspaceMeta | null>(null);
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

  // Deleting a workspace drops its canvas + IndexedDB store for good, so the
  // kebab only *requests* deletion (opens a themed confirm dialog, audit H5);
  // the irreversible work runs on explicit confirm, never on window.confirm.
  const confirmDelete = () => {
    if (!deleteTarget) return;
    ingestion.detach(deleteTarget.id);
    void workspace.remove(deleteTarget.id);
    setDeleteTarget(null);
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
            <SidebarGroupAction title="New workspace" aria-label="New workspace" onClick={add}>
              <Plus /> <span className="sr-only">New workspace</span>
            </SidebarGroupAction>
            <CollapsibleContent>
              <SidebarGroupContent>
                <SidebarMenu>
                  {workspaces.map((ws) => {
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
                          tooltip={`${ws.title} · ${STATUS_HINT[ws.status]}`}
                        >
                          {/* Accent swatch (#111) doubling as the status badge:
                              idle is the bare dot, a live session rings it in
                              status green (pulsing blue while streaming), and
                              error swaps it for a red square. The ring is offset
                              so it reads as a bullseye even when accent and ring
                              hues are close; each state keeps a non-color channel
                              — structure / motion / shape (WCAG 1.4.1) — and the
                              sr-only status suffix below reads it out. When the
                              rail is collapsed the swatch fills the whole button,
                              so its own tooltip would win over — and hide — the
                              button's title tooltip (#143); only give it a
                              tooltip while expanded, where the title is already
                              visible as text alongside it. */}
                          {sidebarState === "collapsed" ? (
                            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                              <span
                                className={cn(
                                  "size-2.5",
                                  ws.status === "error" ? "rounded-[2px] bg-destructive" : "rounded-full",
                                  ws.status === "active" &&
                                    "ring-2 ring-emerald-500 ring-offset-2 ring-offset-sidebar",
                                  ws.status === "streaming" &&
                                    "ring-2 ring-sky-500 ring-offset-2 ring-offset-sidebar animate-pulse"
                                )}
                                style={ws.status === "error" ? undefined : { backgroundColor: accent }}
                              />
                            </span>
                          ) : (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span
                                  className="flex size-4 shrink-0 items-center justify-center"
                                  aria-hidden="true"
                                >
                                  <span
                                    className={cn(
                                      "size-2.5",
                                      ws.status === "error" ? "rounded-[2px] bg-destructive" : "rounded-full",
                                      ws.status === "active" &&
                                        "ring-2 ring-emerald-500 ring-offset-2 ring-offset-sidebar",
                                      ws.status === "streaming" &&
                                        "ring-2 ring-sky-500 ring-offset-2 ring-offset-sidebar animate-pulse"
                                    )}
                                    style={ws.status === "error" ? undefined : { backgroundColor: accent }}
                                  />
                                </span>
                              </TooltipTrigger>
                              <TooltipContent side="right">{STATUS_HINT[ws.status]}</TooltipContent>
                            </Tooltip>
                          )}
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
                            <DropdownMenuItem onSelect={() => void exportWorkspace(ws)}>Export</DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteTarget(ws)}>
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </SidebarMenuItem>
                    );
                  })}
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
