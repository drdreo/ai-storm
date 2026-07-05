import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, ExternalLink, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { SpecFormat } from "@ai-storm/shared";
import { useAgentStore } from "../stores/agent.store";
import { SPEC_FORMATS, type SpecOptions } from "../core/prompt-framing";
import { MarkdownView } from "./MarkdownView";

/** Last-used hand-off format (#110) — repeat hand-offs default sensibly. */
const FORMAT_KEY = "ai-storm-spec-format";

function initialFormat(): SpecFormat {
  const stored = localStorage.getItem(FORMAT_KEY);
  return stored && stored in SPEC_FORMATS ? (stored as SpecFormat) : "prd";
}

/**
 * The spec hand-off panel (#89, PD-015; format options #110) — the convergence
 * step that closes the brainstorm → structure → hand-off loop (PRD §2). It mirrors
 * the synthesis panel (#28): a **read-only reading** of the board, never an editable
 * surface (PD-011 holds). Where synthesis is a pure, instant local read, the spec is
 * *generated* by the downstream agent (PD-007) — so this panel streams the run live
 * (status badge + output) and offers the markdown artifact via Copy / Download once
 * it's there.
 *
 * The format picker (#110) frames the generation as a PRD, an implementation plan,
 * GitHub issues, or agent task prompts — dispatch happens HERE via `onGenerate`
 * (the toolbar verb just opens the panel), so switching format and re-running is
 * one interaction. The panel never touches project/terminal config itself; the
 * parent owns the dispatch.
 *
 * It subscribes to the project's agent run directly, so it re-renders on every
 * stream chunk without re-rendering the canvas. Only `kind: 'spec'` runs surface
 * here; a generic "Send to agent" dispatch streams into the control hub instead.
 */
export function SpecPanel({
  open,
  onOpenChange,
  projectId,
  projectName,
  boardEmpty,
  onGenerate
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId?: string;
  projectName?: string;
  /** The board has no cards to hand off — Generate is gated with why-copy. */
  boardEmpty: boolean;
  onGenerate: (format: SpecFormat, opts: SpecOptions) => void;
}) {
  const run = useAgentStore((s) => (projectId ? (s.runs[projectId] ?? null) : null));
  const spec = run?.kind === "spec" ? run : null;
  const markdown = spec?.output ?? "";
  const done = spec?.status === "exit" || spec?.status === "error";
  const running = spec != null && !done;

  const [format, setFormat] = useState<SpecFormat>(initialFormat);
  const [createIssues, setCreateIssues] = useState(false);
  const pickFormat = (next: SpecFormat) => {
    setFormat(next);
    localStorage.setItem(FORMAT_KEY, next);
  };

  // Transient "it worked" confirmation for the two write actions (#106). Copy and
  // Download both leave the app — one to the OS clipboard, one to a file — with no
  // in-app change to prove they landed. A short-lived `done` flag flips the button
  // to a ✓ + past-tense label, then reverts. One timer, cleared on unmount / re-fire.
  const [flash, setFlash] = useState<"copied" | "downloaded" | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(flashTimer.current), []);
  const confirm = (which: "copied" | "downloaded") => {
    setFlash(which);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 1800);
  };

  const copy = async () => {
    if (!markdown) return;
    await navigator.clipboard?.writeText(markdown);
    confirm("copied");
  };

  const download = () => {
    if (!markdown) return;
    const slug = (projectName ?? "board")
      .trim()
      .replace(/[^\w-]+/g, "-")
      .toLowerCase();
    // Name by the format the run was actually generated as (stamped at dispatch),
    // not the picker's current selection — they diverge once the user re-picks.
    const suffix = spec?.format ? SPEC_FORMATS[spec.format].fileSuffix : "spec";
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slug || "board"}-${suffix}.md`;
    a.click();
    URL.revokeObjectURL(url);
    confirm("downloaded");
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Hand off board
            {spec && (
              <Badge
                variant={spec.status === "error" ? "destructive" : spec.status === "exit" ? "secondary" : "default"}
                className="uppercase"
              >
                {spec.status}
                {spec.code !== undefined ? ` (${spec.code})` : ""}
                {spec.format ? ` · ${SPEC_FORMATS[spec.format].label}` : ""}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            Hand the board off to an agent as a PRD, plan, issue list, or task prompts. This is a snapshot for the agent
            to read — it won't change your board; keep refining on the canvas.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-3 border-b px-4 pb-4">
          <Field>
            <FieldLabel htmlFor="spec-format">Format</FieldLabel>
            <Select value={format} onValueChange={(v) => pickFormat(v as SpecFormat)}>
              <SelectTrigger id="spec-format" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(SPEC_FORMATS) as SpecFormat[]).map((f) => (
                  <SelectItem key={f} value={f}>
                    {SPEC_FORMATS[f].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{SPEC_FORMATS[format].description}</FieldDescription>
          </Field>

          {format === "issues" && (
            <Field orientation="horizontal">
              <Checkbox
                id="spec-create-issues"
                checked={createIssues}
                onCheckedChange={(checked) => setCreateIssues(checked === true)}
              />
              <FieldContent>
                <FieldLabel htmlFor="spec-create-issues">
                  Actually create the issues via <code>gh</code>
                </FieldLabel>
                <FieldDescription>
                  Permission is granted for this run only (scoped to <code>gh issue create</code>); needs{" "}
                  <code>gh</code> auth. Off = ready-to-file drafts, no side effects.
                </FieldDescription>
              </FieldContent>
            </Field>
          )}

          <Button size="sm" onClick={() => onGenerate(format, { createIssues })} disabled={boardEmpty || running}>
            <Sparkles aria-hidden /> {spec ? "Regenerate" : "Generate"}
          </Button>
          {boardEmpty && (
            <p className="text-xs text-muted-foreground">The board is empty — add cards before handing off.</p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {!spec ? (
            <p className="text-sm text-muted-foreground">No hand-off yet — pick a format above and press Generate.</p>
          ) : markdown ? (
            <>
              <MarkdownView markdown={markdown} />
              {spec.artifacts && spec.artifacts.length > 0 && (
                <div className="mt-3 border-t pt-3">
                  {/* Structured created-issue artifacts parsed server-side (#120) —
                      link chips, the deferred follow-up from #110. */}
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">Created issues</p>
                  <div className="flex flex-wrap gap-1.5 pb-3">
                    {spec.artifacts.map((a) => (
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
            <p className="text-sm text-muted-foreground">
              {done
                ? "The agent produced no output."
                : `Generating the ${spec.format ? SPEC_FORMATS[spec.format].label : "spec"}…`}
            </p>
          )}
        </div>

        <div className="flex gap-2 border-t p-4">
          <Button size="sm" variant="outline" onClick={copy} disabled={!markdown}>
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
          <Button size="sm" onClick={download} disabled={!markdown}>
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
          {/* Screen-reader announcement mirroring the visual flash (the icon swap
              alone is silent to AT). */}
          <span role="status" aria-live="polite" className="sr-only">
            {flash === "copied" ? "Spec copied to clipboard" : flash === "downloaded" ? "Spec downloaded" : ""}
          </span>
        </div>
      </SheetContent>
    </Sheet>
  );
}
