import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import {
  SidebarInput,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronRight, Folder as FolderIcon, GripVertical, MoreHorizontal } from "lucide-react";
import type { Folder } from "@ai-storm/shared";
import { workspace } from "../../stores/workspace.store";
import type { DragKind } from "./useSidebarDnd";
import { UNGROUPED_ZONE } from "./useSidebarDnd";

export interface FolderGroupProps {
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
export function SortableFolderGroup(props: FolderGroupProps) {
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
export function UngroupedDropZone() {
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
