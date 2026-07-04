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
import { SidebarInput, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Check, MoreHorizontal } from "lucide-react";
import type { Folder, WorkspaceMeta, WorkspaceStatus } from "@ai-storm/shared";
import { defaultWorkspaceColor, WORKSPACE_COLORS } from "../../core/models";
import { workspace } from "../../stores/workspace.store";
import type { DragKind } from "./useSidebarDnd";

/** Hover explanation for the workspace status badge (the ringed accent dot). */
const STATUS_HINT: Record<WorkspaceStatus, string> = {
  idle: "No session running",
  active: "Session live",
  streaming: "Session live — agent responding",
  error: "Session error — open the workspace for details"
};

/** The workspace status/accent dot, shared by the row and the drag overlay. */
export function StatusDot({ ws }: { ws: WorkspaceMeta }) {
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

export interface WorkspaceRowProps {
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
 * small distance threshold so click/double-click still activate/rename) —
 * grabbing the row itself is discoverable enough that a dedicated grip icon
 * would just be extra chrome.
 */
export function SortableWorkspaceRow(props: WorkspaceRowProps) {
  const { ws, isActive, isEditing, folders } = props;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
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
    // "group/ws-row", not the ambient "group/menu-item" every SidebarMenuItem
    // carries: a row nested inside a folder is a DOM descendant of the
    // folder's own li, which *also* carries "menu-item" — so a hover-reveal
    // keyed to that shared name would fire for this row whenever the folder
    // box (header or any sibling row) is hovered, not just this row. Scoping
    // to a name unique to rows means only *this* row's own li can satisfy it.
    <SidebarMenuItem ref={setNodeRef} style={style} className={cn("group/ws-row", isDragging && "opacity-40")}>
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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            className="opacity-0 group-hover/ws-row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 md:opacity-0"
            aria-label={`Manage ${ws.title}`}
          >
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
