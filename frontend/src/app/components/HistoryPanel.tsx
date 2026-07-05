import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, Copy, Download, ExternalLink, FileOutput, Scale, ScrollText, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { downloadFile } from "../core/download-file";
import { SPEC_FORMATS } from "../core/prompt-framing";
import type { RunHistoryEntry, RunHistoryStatus, RunHistoryType } from "../core/run-history";
import { history, projectHistory, useHistoryStore } from "../stores/history.store";
import { MarkdownView } from "./MarkdownView";

const TYPE_META: Record<RunHistoryType, { label: string; icon: typeof FileOutput }> = {
  spec: { label: "Hand-off", icon: FileOutput },
  synthesis: { label: "Summary", icon: ScrollText },
  triage: { label: "Triage", icon: Scale }
};

const STATUS_META: Record<
  RunHistoryStatus,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  running: { label: "running", variant: "default" },
  done: { label: "done", variant: "secondary" },
  empty: { label: "no output", variant: "outline" },
  error: { label: "failed", variant: "destructive" },
  interrupted: { label: "interrupted", variant: "destructive" }
};

function entryTitle(entry: RunHistoryEntry): string {
  if (entry.type === "spec" && entry.format) return SPEC_FORMATS[entry.format].label;
  return TYPE_META[entry.type].label;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/** The metadata line under a row/detail title: timestamp plus type-specific facts. */
function entryMeta(entry: RunHistoryEntry): string {
  const parts = [formatTimestamp(entry.createdAt)];
  if (entry.type === "triage" && entry.cardCount !== undefined) {
    parts.push(`${entry.scoredCount ?? 0}/${entry.cardCount} cards scored`);
  } else if (entry.type === "synthesis" && entry.cardCount !== undefined) {
    parts.push(`${entry.cardCount} ${entry.cardCount === 1 ? "idea" : "ideas"}`);
  } else if (entry.type === "spec" && entry.exitCode !== undefined && entry.exitCode !== 0) {
    parts.push(`exit ${entry.exitCode}`);
  }
  return parts.join(" · ");
}

/** Why a terminal entry has nothing to show — the "represented clearly" copy (#104). */
function emptyReason(entry: RunHistoryEntry): string {
  switch (entry.status) {
    case "running":
      return "Still running — output lands here when it finishes.";
    case "error":
      return "The run failed and produced no output.";
    case "interrupted":
      return "The app was closed before this run finished — no output was captured.";
    default:
      return entry.type === "triage"
        ? "Triage runs record request metadata only — scores land on the cards themselves."
        : "The run produced no output.";
  }
}

/**
 * Run history panel (#104) — per-project, local-first history of convergence
 * runs: spec/PRD hand-offs, synthesis snapshots, and triage metadata. Entries
 * persist across reloads (a CRDT store in IndexedDB, `history.store`), so a
 * completed hand-off can be reopened long after the SpecPanel closed. The list
 * shows timestamp, action type, status, and an output preview; selecting an
 * entry opens the stored artifact with Copy / Download — same affordances as
 * the live panels, pointed at history.
 */
export function HistoryPanel({
  open,
  onOpenChange,
  projectId,
  projectName
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string;
  projectName?: string;
}) {
  const entries = useHistoryStore((s) => s.entries);
  const projectEntries = useMemo(() => (projectId ? projectHistory(entries, projectId) : []), [entries, projectId]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Back to the list whenever the panel reopens or the project changes.
  useEffect(() => {
    setSelectedId(null);
  }, [open, projectId]);
  const selected = projectEntries.find((e) => e.id === selectedId) ?? null;

  // Transient "it worked" confirmation for Copy/Download — same pattern as the
  // SpecPanel (#106): both actions leave the app with no in-app proof.
  const [flash, setFlash] = useState<"copied" | "downloaded" | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const confirm = (which: "copied" | "downloaded") => {
    setFlash(which);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1800);
  };

  const copy = async () => {
    if (!selected?.output) return;
    await navigator.clipboard?.writeText(selected.output);
    confirm("copied");
  };

  const download = () => {
    if (!selected?.output) return;
    const slug = (projectName ?? "board")
      .trim()
      .replace(/[^\w-]+/g, "-")
      .toLowerCase();
    const suffix =
      selected.type === "spec" ? (selected.format ? SPEC_FORMATS[selected.format].fileSuffix : "spec") : "summary";
    downloadFile(`${slug || "board"}-${suffix}.md`, selected.output, "text/markdown");
    confirm("downloaded");
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {selected ? (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="-ml-2 size-7"
                  aria-label="Back to history list"
                  onClick={() => setSelectedId(null)}
                >
                  <ArrowLeft />
                </Button>
                {entryTitle(selected)}
                <Badge variant={STATUS_META[selected.status].variant} className="uppercase">
                  {STATUS_META[selected.status].label}
                </Badge>
              </>
            ) : (
              "Run history"
            )}
          </SheetTitle>
          <SheetDescription>
            {selected
              ? entryMeta(selected)
              : "Past summaries, triage passes, and hand-offs for this project — stored locally, kept across reloads."}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {selected ? (
            selected.output ? (
              <>
                <MarkdownView markdown={selected.output} />
                {selected.artifacts && selected.artifacts.length > 0 && (
                  <div className="mt-3 border-t pt-3">
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">Created issues</p>
                    <div className="flex flex-wrap gap-1.5 pb-3">
                      {selected.artifacts.map((a) => (
                        <a
                          key={a.url}
                          href={a.url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex max-w-full items-center gap-1 rounded-full border bg-secondary px-2.5 py-0.5 text-xs text-secondary-foreground hover:bg-secondary/80"
                          title={a.url}
                        >
                          <ExternalLink className="size-3 shrink-0" aria-hidden />
                          <span className="truncate">{a.title}</span>
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{emptyReason(selected)}</p>
            )
          ) : projectEntries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No runs yet — Summarize, Triage, and Export runs will show up here.
            </p>
          ) : (
            <ul className="flex flex-col gap-1 pb-4">
              {projectEntries.map((entry) => {
                const Icon = TYPE_META[entry.type].icon;
                return (
                  <li key={entry.id} className="group relative">
                    <button
                      type="button"
                      className="flex w-full flex-col gap-0.5 rounded-md border px-3 py-2 text-left hover:bg-accent"
                      onClick={() => setSelectedId(entry.id)}
                    >
                      <span className="flex items-center gap-2 pr-7">
                        <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="truncate text-sm font-medium">{entryTitle(entry)}</span>
                        <Badge variant={STATUS_META[entry.status].variant} className="ml-auto shrink-0 uppercase">
                          {STATUS_META[entry.status].label}
                        </Badge>
                      </span>
                      <span className="text-xs text-muted-foreground">{entryMeta(entry)}</span>
                      {entry.preview && (
                        <span className="line-clamp-2 text-xs text-muted-foreground">{entry.preview}</span>
                      )}
                    </button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="absolute right-1 top-1 size-6 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                      aria-label={`Delete ${entryTitle(entry)} entry`}
                      onClick={() => history.remove(entry.id)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex gap-2 border-t p-4">
          {selected ? (
            <>
              <Button size="sm" variant="outline" onClick={copy} disabled={!selected.output}>
                {flash === "copied" ? (
                  <>
                    <Check className="text-emerald-600 dark:text-emerald-500" aria-hidden /> Copied
                  </>
                ) : (
                  <>
                    <Copy aria-hidden /> Copy markdown
                  </>
                )}
              </Button>
              <Button size="sm" onClick={download} disabled={!selected.output}>
                {flash === "downloaded" ? (
                  <>
                    <Check aria-hidden /> Downloaded
                  </>
                ) : (
                  <>
                    <Download aria-hidden /> Download .md
                  </>
                )}
              </Button>
              <span role="status" aria-live="polite" className="sr-only">
                {flash === "copied" ? "Output copied to clipboard" : flash === "downloaded" ? "Output downloaded" : ""}
              </span>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={projectEntries.length === 0}
              onClick={() => projectId && history.removeProject(projectId)}
            >
              <Trash2 aria-hidden /> Clear history
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
