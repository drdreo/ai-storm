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
import type { Folder, ProjectMeta, ProjectStatus } from "@ai-storm/shared";
import { defaultProjectColor, PROJECT_COLORS } from "../../core/models";
import { project } from "../../stores/project.store";
import { useBackendStore } from "../../stores/backend.store";
import { useIngestionStore } from "../../stores/ingestion.store";
import { sessionIndicator } from "../../core/session-status";
import type { DragKind } from "./useSidebarDnd";

/** Hover explanation for the project status badge (the ringed accent dot). */
const STATUS_HINT: Record<ProjectStatus, string> = {
  idle: "No session running",
  active: "Session live",
  streaming: "Session live — agent responding",
  error: "Session error — open the project for details"
};

/** What the dot/tooltip actually renders — the one place status and connection are merged. */
type DotDisplay = { shape: "idle" | "active" | "streaming" | "pending" | "error"; hint: string };

/**
 * A project's cached `status` (#178) is only updated by inbound server
 * messages, so it stays "active"/"streaming" after the websocket drops —
 * the sidebar would otherwise keep showing a session as live while the
 * backend is actually connecting or offline. This is the single place that
 * reconciles the persisted `status` with the live connection/attach state
 * (via `sessionIndicator`, the same derivation the Control Hub header uses)
 * into one display value — callers below never read `ws.status` directly.
 */
function useDotDisplay(ws: ProjectMeta): DotDisplay {
  const connState = useBackendStore((s) => s.state);
  const attached = useIngestionStore((s) => !!s.attached[ws.id]);

  if (ws.status === "error") return { shape: "error", hint: STATUS_HINT.error };

  const claimsLive = ws.status === "active" || ws.status === "streaming";
  if (claimsLive) {
    const indicator = sessionIndicator(connState, attached, ws.status);
    if (indicator.tone !== "ok") return { shape: "pending", hint: indicator.label };
    return { shape: ws.status, hint: STATUS_HINT[ws.status] };
  }
  return { shape: "idle", hint: STATUS_HINT.idle };
}

/** The project status/accent dot, shared by the row and the drag overlay. */
export function StatusDot({ ws }: { ws: ProjectMeta }) {
  const accent = ws.color ?? defaultProjectColor(ws.id);
  const { shape, hint } = useDotDisplay(ws);
  return (
    <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden="true" data-testid="status-dot">
      <span
        className={cn(
          "size-2.5",
          shape === "error" ? "rounded-[2px] bg-destructive" : "rounded-full",
          shape === "active" && "ring-2 ring-emerald-500 ring-offset-2 ring-offset-sidebar",
          shape === "streaming" && "ring-2 ring-sky-500 ring-offset-2 ring-offset-sidebar animate-pulse",
          shape === "pending" && "ring-2 ring-amber-500 ring-offset-2 ring-offset-sidebar animate-pulse"
        )}
        style={shape === "error" ? undefined : { backgroundColor: accent }}
        title={shape === "pending" ? hint : undefined}
      />
    </span>
  );
}

export interface ProjectRowProps {
  ws: ProjectMeta;
  isActive: boolean;
  isEditing: boolean;
  folders: Folder[];
  onStartRename: (id: string) => void;
  onCommitRename: (ws: ProjectMeta, value: string) => void;
  onRenameKey: (e: React.KeyboardEvent<HTMLInputElement>, ws: ProjectMeta) => void;
  renameInputRef: (el: HTMLInputElement | null) => void;
  onRequestDelete: (ws: ProjectMeta) => void;
  onExport: (ws: ProjectMeta) => void;
}

/**
 * A single sortable project row (status dot, inline rename, kebab). Shared
 * between the top-level list and the rows nested inside a folder group.
 *
 * Drag ergonomics (#128 DnD): the whole row is a pointer drag source (with a
 * small distance threshold so click/double-click still activate/rename) —
 * grabbing the row itself is discoverable enough that a dedicated grip icon
 * would just be extra chrome.
 */
export function SortableProjectRow(props: ProjectRowProps) {
  const { ws, isActive, isEditing, folders } = props;
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ws.id,
    data: { kind: "project" satisfies DragKind },
    disabled: isEditing
  });
  const style: React.CSSProperties = { transform: CSS.Translate.toString(transform), transition };
  // Called unconditionally — the row can bail out to the rename input below,
  // and hooks can't follow that early return (#178 regression: this used to
  // be a plain computation, but now subscribes to the backend/ingestion
  // stores, so it must run on every render regardless of `isEditing`).
  const { shape, hint } = useDotDisplay(ws);

  if (isEditing) {
    return (
      <SidebarMenuItem>
        <SidebarInput
          ref={props.renameInputRef}
          defaultValue={ws.title}
          aria-label="Rename project"
          onKeyDown={(e) => props.onRenameKey(e, ws)}
          onBlur={(e) => props.onCommitRename(ws, e.currentTarget.value)}
        />
      </SidebarMenuItem>
    );
  }

  const accent = ws.color ?? defaultProjectColor(ws.id);
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
        onClick={() => project.setActive(ws.id)}
        onDoubleClick={() => props.onStartRename(ws.id)}
        onPointerDown={listeners?.onPointerDown as React.PointerEventHandler<HTMLButtonElement> | undefined}
        tooltip={shape === "idle" ? ws.title : `${ws.title} · ${hint}`}
      >
        <StatusDot ws={ws} />
        <span className="truncate">{ws.title}</span>
        <span className="sr-only">— {shape}</span>
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
                <div className="grid grid-cols-5 gap-1.5" role="group" aria-label="Project color">
                  {PROJECT_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={`Set color ${c}`}
                      aria-pressed={accent === c}
                      onClick={() => project.setColor(ws.id, c)}
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
                <DropdownMenuItem onSelect={() => project.moveToFolder(ws.id, null)}>
                  {!ws.folderId && <Check className="size-3.5" />}
                  <span className={cn(!ws.folderId && "font-medium")}>No folder</span>
                </DropdownMenuItem>
                {folders.length > 0 && <DropdownMenuSeparator />}
                {folders.map((f) => (
                  <DropdownMenuItem key={f.id} onSelect={() => project.moveToFolder(ws.id, f.id)}>
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
