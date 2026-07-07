import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { useState } from "react";
import type { ExportedProject } from "../../core/project-portable";

export interface ImportProjectsDialogProps {
  /** Parsed entries from the chosen export file. */
  entries: ExportedProject[];
  /** Titles of projects that already exist (case-sensitive match). */
  existingTitles: ReadonlySet<string>;
  onCancel: () => void;
  onConfirm: (selected: ExportedProject[]) => void;
}

/**
 * Selection step for importing a whole-state export: lists every project in
 * the file with a checkbox so the user picks which ones to bring in. Entries
 * whose title already exists locally are flagged and start unchecked (imports
 * always create new projects, so re-importing one would create a duplicate).
 * Mounted fresh per import (parent renders it conditionally), so the initial
 * selection can live in plain `useState`.
 */
export function ImportProjectsDialog({ entries, existingTitles, onCancel, onConfirm }: ImportProjectsDialogProps) {
  const [checked, setChecked] = useState(() => entries.map((e) => !existingTitles.has(e.title)));
  const selectedCount = checked.filter(Boolean).length;

  const toggle = (index: number, value: boolean) => {
    setChecked((prev) => prev.map((c, i) => (i === index ? value : c)));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import projects</DialogTitle>
          <DialogDescription>
            Choose which projects to import. Each import creates a new project — existing ones are never overwritten.
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {entries.map((entry, i) => (
            <label
              key={i}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-accent"
            >
              <Checkbox checked={checked[i]} onCheckedChange={(v) => toggle(i, v === true)} />
              <span className="min-w-0 flex-1 truncate">{entry.title}</span>
              {existingTitles.has(entry.title) && (
                <Badge variant="outline" className="shrink-0 text-muted-foreground">
                  exists
                </Badge>
              )}
              <span className="shrink-0 text-xs text-muted-foreground">
                {entry.board.cards.length} {entry.board.cards.length === 1 ? "card" : "cards"}
              </span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" size="sm">
              Cancel
            </Button>
          </DialogClose>
          <Button
            size="sm"
            disabled={selectedCount === 0}
            onClick={() => onConfirm(entries.filter((_, i) => checked[i]))}
          >
            Import {selectedCount} {selectedCount === 1 ? "project" : "projects"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
