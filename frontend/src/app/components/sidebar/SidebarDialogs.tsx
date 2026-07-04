import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import type { Folder, ProjectMeta } from "@ai-storm/shared";

export interface SidebarDialogsProps {
  deleteTarget: ProjectMeta | null;
  onDeleteTargetChange: (target: ProjectMeta | null) => void;
  onConfirmDelete: () => void;
  deleteFolderTarget: Folder | null;
  onDeleteFolderTargetChange: (target: Folder | null) => void;
  onConfirmDeleteFolder: () => void;
  importError: string | null;
  onImportErrorChange: (error: string | null) => void;
}

/**
 * The Sidebar's confirm/error dialogs (delete project, delete folder, import
 * failed) — split out since they're pure presentation over parent-owned state,
 * no drag-and-drop or CRDT concerns of their own.
 */
export function SidebarDialogs(props: SidebarDialogsProps) {
  const { deleteTarget, deleteFolderTarget, importError } = props;
  return (
    <>
      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && props.onDeleteTargetChange(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete project?</DialogTitle>
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
            <Button variant="destructive" size="sm" onClick={props.onConfirmDelete}>
              Delete project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteFolderTarget} onOpenChange={(open) => !open && props.onDeleteFolderTargetChange(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete folder?</DialogTitle>
            <DialogDescription>
              “{deleteFolderTarget?.title}” will be removed. Its projects are kept and moved back to the top level.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" size="sm">
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" size="sm" onClick={props.onConfirmDeleteFolder}>
              Delete folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!importError} onOpenChange={(open) => !open && props.onImportErrorChange(null)}>
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
    </>
  );
}
