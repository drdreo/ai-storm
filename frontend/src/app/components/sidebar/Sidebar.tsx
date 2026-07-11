import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail
} from "@/components/ui/sidebar";
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ChevronDown, Folder as FolderIcon, FolderPlus, Plus, Settings } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type { Folder, ProjectMeta } from "@ai-storm/shared";
import { downloadFile } from "../../core/download-file";
import { exportFileSlug, parseImportFile, type ExportedProject } from "../../core/project-portable";
import { ingestion } from "../../stores/ingestion.store";
import { ui, useUiStore } from "../../stores/ui.store";
import { useProjectStore, project } from "../../stores/project.store";
import { SettingsDialog } from "../SettingsDialog";
import { ImportProjectsDialog } from "./ImportProjectsDialog";
import { SidebarDialogs } from "./SidebarDialogs";
import { SortableFolderGroup, UngroupedDropZone } from "./SidebarFolderGroup";
import { StatusDot, SortableProjectRow } from "./SidebarProjectRow";
import { useSidebarDnd } from "./useSidebarDnd";

/**
 * Global navigation sidebar (PRD §3.4), built on shadcn's app-sidebar
 * composition: an inset, icon-collapsible Sidebar with a branded header, a
 * collapsible "Projects" group whose action (+) creates a project, a rail
 * toggle, and a settings footer. Entries are stock
 * SidebarMenuButtons (default styling + the built-in active indicator). The
 * per-row kebab is a Radix DropdownMenu; rename is an inline input.
 *
 * Ordering is user-controlled via drag & drop (#128, {@link useSidebarDnd}):
 * folders sort among folders, projects sort within and across containers
 * (folder ↔ top level), persisted as fractional-index keys on the registry
 * CRDT. Rows/folder groups/dialogs are split into `./sidebar/*` — this file is
 * just the layout + the state that spans all of them (rename/delete targets).
 */
export function Sidebar() {
  const projects = useProjectStore((s) => s.projects);
  const folders = useProjectStore((s) => s.folders);
  const activeId = useProjectStore((s) => s.activeId);
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProjectMeta | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<Folder | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importEntries, setImportEntries] = useState<ExportedProject[] | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const dnd = useSidebarDnd(projects, folders);

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
    const id = project.create("Untitled Project");
    project.setActive(id);
  };

  const addFolder = () => {
    keepRenameFocusRef.current = true;
    setEditingId(project.createFolder("New Folder"));
  };

  const commitRename = (ws: ProjectMeta, value: string) => {
    if (editingId !== ws.id) return;
    const title = value.trim();
    if (title && title !== ws.title) project.rename(ws.id, title);
    setEditingId(null);
  };

  const onRenameKey = (e: React.KeyboardEvent<HTMLInputElement>, ws: ProjectMeta) => {
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
    if (title && title !== folder.title) project.renameFolder(folder.id, title);
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

  // Deleting a project drops its backend canvas/history files for good, so the
  // kebab only *requests* deletion (opens a themed confirm dialog, audit H5);
  // the irreversible work runs on explicit confirm, never on window.confirm.
  const confirmDelete = () => {
    if (!deleteTarget) return;
    ingestion.detach(deleteTarget.id);
    void project.remove(deleteTarget.id);
    setDeleteTarget(null);
  };

  // Deleting a folder only drops the container — its projects (and their
  // canvases) survive, falling back to the sidebar's top level.
  const confirmDeleteFolder = () => {
    if (!deleteFolderTarget) return;
    project.removeFolder(deleteFolderTarget.id);
    setDeleteFolderTarget(null);
  };

  // Export switches onto the target project first (a live editor is needed to
  // read the board), then downloads its portable JSON bundle (#105).
  const exportProject = async (ws: ProjectMeta) => {
    const bundle = await project.exportBundle(ws.id);
    if (!bundle) return;
    downloadFile(`${exportFileSlug(ws.title)}-project.json`, JSON.stringify(bundle, null, 2), "application/json");
  };

  // Whole-state export (all projects, one file), triggered from the settings
  // dialog's Projects row. Boards are read from the live editor, so this flips
  // through the projects and restores the active one.
  const exportAll = async () => {
    const bundle = await project.exportAll();
    const date = new Date(bundle.exportedAt).toISOString().slice(0, 10);
    downloadFile(`ai-storm-export-${date}.json`, JSON.stringify(bundle, null, 2), "application/json");
  };

  const importProject = () => importInputRef.current?.click();

  // A single-project file imports immediately (as before); a whole-state file
  // opens a selection dialog so the user picks which projects to bring in.
  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const entries = parseImportFile(await file.text());
      if (entries.length === 1) await project.importProjects(entries);
      else setImportEntries(entries);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed.");
    }
  };

  const confirmImport = async (selected: ExportedProject[]) => {
    setImportEntries(null);
    try {
      await project.importProjects(selected);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed.");
    }
  };

  const renderRow = (ws: ProjectMeta) => (
    <SortableProjectRow
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
      onExport={(ws) => void exportProject(ws)}
    />
  );

  const ungrouped = projects.filter((w) => dnd.containerOf(w) === null);

  return (
    <UISidebar variant="inset" collapsible="icon" data-tour="sidebar">
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
                  <span className="truncate font-semibold">AI Storm</span>
                  <span className="truncate text-xs text-muted-foreground">by DrDreo</span>
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
                Projects
                <ChevronDown className="ml-1 size-3.5 transition-transform group-data-[state=closed]/collapsible:-rotate-90" />
              </CollapsibleTrigger>
            </SidebarGroupLabel>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => void onImportFile(e)}
            />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarGroupAction title="New…" aria-label="New project or folder">
                  <Plus /> <span className="sr-only">New project or folder</span>
                </SidebarGroupAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="right"
                align="start"
                className="min-w-[156px]"
                onCloseAutoFocus={onNewMenuCloseAutoFocus}
              >
                <DropdownMenuItem onSelect={add}>
                  <Plus className="size-4" /> New project
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={addFolder}>
                  <FolderPlus className="size-4" /> New folder
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <CollapsibleContent>
              <SidebarGroupContent>
                <DndContext
                  sensors={dnd.sensors}
                  collisionDetection={dnd.collisionDetection}
                  modifiers={[restrictToVerticalAxis]}
                  onDragStart={dnd.onDragStart}
                  onDragEnd={dnd.onDragEnd}
                  onDragCancel={dnd.onDragCancel}
                >
                  <SidebarMenu>
                    <SortableContext items={folders.map((f) => f.id)} strategy={verticalListSortingStrategy}>
                      {folders.map((folder) => {
                        const children = projects.filter((w) => w.folderId === folder.id);
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
                      {ungrouped.length === 0 && dnd.drag?.kind === "project" && <UngroupedDropZone />}
                    </SortableContext>
                  </SidebarMenu>

                  <DragOverlay>
                    {dnd.draggedWs ? (
                      <div className="flex items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-sm text-sidebar-accent-foreground shadow-md">
                        <StatusDot ws={dnd.draggedWs} />
                        <span className="truncate">{dnd.draggedWs.title}</span>
                      </div>
                    ) : dnd.draggedFolder ? (
                      <div className="flex items-center gap-2 rounded-md bg-sidebar-accent px-2 py-1.5 text-sm text-sidebar-accent-foreground shadow-md">
                        <FolderIcon className="size-4 shrink-0" />
                        <span className="truncate">{dnd.draggedFolder.title}</span>
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
            <SidebarMenuButton size="sm" onClick={() => ui.openSettings()} tooltip="Settings" data-tour="settings">
              <Settings className="size-4" />
              <span className="truncate text-xs">Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={ui.setSettingsOpen}
        onExportAll={() => void exportAll()}
        onImportProjects={importProject}
      />

      {importEntries && (
        <ImportProjectsDialog
          entries={importEntries}
          existingTitles={new Set(projects.map((w) => w.title))}
          onCancel={() => setImportEntries(null)}
          onConfirm={(selected) => void confirmImport(selected)}
        />
      )}

      <SidebarDialogs
        deleteTarget={deleteTarget}
        onDeleteTargetChange={setDeleteTarget}
        onConfirmDelete={confirmDelete}
        deleteFolderTarget={deleteFolderTarget}
        onDeleteFolderTargetChange={setDeleteFolderTarget}
        onConfirmDeleteFolder={confirmDeleteFolder}
        importError={importError}
        onImportErrorChange={setImportError}
      />

      <SidebarRail />
    </UISidebar>
  );
}
