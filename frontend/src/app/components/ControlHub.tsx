import { useEffect } from "react";
import * as Toolbar from "@radix-ui/react-toolbar";
import { ChevronDown, PanelRightClose } from "lucide-react";
import { FACILITATION_MODES, getFacilitationMode } from "@ai-storm/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useProjectStore, selectActive, project } from "../stores/project.store";
import { useIngestionStore, ingestion } from "../stores/ingestion.store";
import { useBackendStore } from "../stores/backend.store";
import { sessionIndicator } from "../core/session-status";
import { StatusDot } from "./SessionStatusDot";
import { Terminal } from "./Terminal";
import { DirectoryPicker } from "./DirectoryPicker";

/**
 * Soft cap on the background context (#76). Not enforced — the textarea rides
 * every turn's prompt, so past the cap the counter turns amber to nudge the user
 * toward something the agent can actually keep in view, rather than blocking.
 */
const BACKGROUND_SOFT_CAP = 1500;

/**
 * Conversational Control Hub (PRD §3.1). The conversation surface is a real
 * terminal (xterm.js, fed the raw PTY stream — see Terminal), so this shell
 * provides the session controls, the harness selector, and diagnostic readouts
 * of the background connection.
 */
export function ControlHub({ onCollapse }: { onCollapse?: () => void }) {
  const ws = useProjectStore(selectActive);
  const connState = useBackendStore((s) => s.state);
  const attached = useIngestionStore((s) => (ws ? !!s.attached[ws.id] : false));
  const sessionError = useIngestionStore((s) => (ws ? (s.errors[ws.id] ?? null) : null));

  // Resume a durable session after a reload / hot-switch (PRD §3.5). `attach` is
  // idempotent: it reconnects to the surviving backend session rather than
  // respawning it. Gated on the persisted live status so visiting a never-started
  // project does not spawn a harness.
  useEffect(() => {
    if (!ws) return;
    const wasLive = ws.status === "active" || ws.status === "streaming";
    if (wasLive && !ingestion.isAttached(ws.id)) {
      ingestion.attach(ws.id, ws.terminal);
    }
  }, [ws, attached]);

  // Seed a sane default working directory (#152): the browser can't see the
  // OS filesystem, so the home directory comes from the backend (same machine
  // the harness will spawn on). Only fills in an unset cwd — never overwrites
  // a directory the user already picked.
  useEffect(() => {
    if (!ws || ws.terminal.cwd) return;
    const id = ws.id;
    let cancelled = false;
    fetch("/api/fs/home")
      .then((res) => (res.ok ? (res.json() as Promise<{ home: string }>) : null))
      .then((data) => {
        if (!cancelled && data?.home) project.patchTerminal(id, { cwd: data.home });
      })
      .catch(() => {
        // Offline or no backend yet — leave cwd unset; the picker still works
        // once the backend is reachable, and the spawn falls back sanely.
      });
    return () => {
      cancelled = true;
    };
  }, [ws]);

  if (!ws) return null;

  const harness = ws.terminal.agentCommand || "claude";
  const mode = getFacilitationMode(ws.terminal.mode);
  const background = ws.terminal.background ?? "";
  const overCap = background.length > BACKGROUND_SOFT_CAP;

  // One indication instead of three (#97 follow-up): connection state used to
  // appear in the header, a readiness checklist, and the sidebar footer. The
  // checklist is gone — the only check that could ever fail was the backend
  // connection (harness/mode always resolve, background is visible below) — so
  // the header carries a single derived session state and the Start tooltip
  // carries the reason when it's disabled.
  const indicator = sessionIndicator(connState, attached, ws.status);
  const offline = connState === "closed";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-[var(--toolbar-h)] shrink-0 items-center justify-between border-b px-3">
        <div className="flex items-center gap-3">
          <div
            className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            title={indicator.detail}
          >
            <StatusDot tone={indicator.tone} />
            <span className={cn(indicator.tone === "error" && "text-destructive")}>{indicator.label}</span>
          </div>
          <Toolbar.Root className="flex gap-2" aria-label="Session controls">
            {attached ? (
              <Toolbar.Button asChild>
                <Button
                  size="sm"
                  variant="destructive"
                  className="animate-in fade-in duration-300"
                  onClick={() => ingestion.kill(ws.id)}
                >
                  Stop
                </Button>
              </Toolbar.Button>
            ) : (
              <Toolbar.Button asChild>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="animate-in fade-in duration-300">
                      <Button size="sm" disabled={offline} onClick={() => ingestion.attach(ws.id, ws.terminal)}>
                        Start session
                      </Button>
                    </span>
                  </TooltipTrigger>
                  {offline && (
                    <TooltipContent>Backend offline — start the backend to launch a session.</TooltipContent>
                  )}
                </Tooltip>
              </Toolbar.Button>
            )}
          </Toolbar.Root>
        </div>
        {onCollapse && (
          <Toolbar.Root aria-label="Panel controls">
            <Toolbar.Button asChild>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label="Collapse control hub" onClick={onCollapse}>
                    <PanelRightClose className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Collapse control hub</TooltipContent>
              </Tooltip>
            </Toolbar.Button>
          </Toolbar.Root>
        )}
      </header>

      {/* Last backend error (e.g. a harness that couldn't be launched). Shown
          here, not just as a status dot, so the user can read *why* and act on
          it — and dismiss it once handled. */}
      {sessionError && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium">{sessionError}</span>
          <button
            type="button"
            onClick={() => ingestion.clearError(ws.id)}
            className="shrink-0 font-medium uppercase tracking-wide underline-offset-2 hover:underline"
            aria-label="Dismiss error"
          >
            Dismiss
          </button>
        </div>
      )}

      {attached ? (
        /* Live sessions don't need the setup wizard — harness/mode/directory/
           background are baked in at launch and can't change until Stop, and
           "session live" is already carried by the header dot (no need to say
           it twice). A quiet one-line summary keeps the fields glanceable
           without spending permanent vertical space next to the terminal. */
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground animate-in fade-in duration-300"
          title="Baked in at launch. Stop & Start to change harness, mode, directory or background."
        >
          <span className="font-mono text-foreground">{harness}</span>
          <span aria-hidden="true">·</span>
          <span>{mode.label}</span>
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate font-mono">{ws.terminal.cwd || "~"}</span>
        </div>
      ) : (
        /* Session setup (#76): harness + facilitation mode + background context.
            All three are baked into the launch system-prompt, so they share one
            rule — editable before start, locked once the session is live. */
        <section className="border-b px-3 py-2 text-xs text-muted-foreground">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-medium uppercase tracking-wide">Session setup · applied on start</span>
          </div>

          <div className="flex items-center gap-2">
            <label className="font-medium uppercase tracking-wide">harness</label>
            <Input
              className="h-7 w-44 font-mono text-xs"
              defaultValue={harness}
              key={ws.id}
              placeholder="claude, pi, codex, or opencode"
              spellCheck={false}
              onChange={(e) => project.patchTerminal(ws.id, { agentCommand: e.target.value.trim() || "claude" })}
              title="The AI CLI launched for this project's session (PRD §2). Keystrokes are sent to its PTY."
            />
            <span className="truncate italic">{mode.hint}</span>
            {/* Facilitation mode picker (#61): swaps the priming preset the agent is
                launched with. */}
            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline" className="ml-auto h-7 gap-1 font-mono text-xs">
                      {mode.label}
                      <ChevronDown className="size-3 opacity-60" />
                    </Button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  Facilitation mode — how the agent ideates (#61). Applied on session start.
                </TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end">
                <DropdownMenuRadioGroup
                  value={mode.id}
                  onValueChange={(id) => project.patchTerminal(ws.id, { mode: id })}
                >
                  {FACILITATION_MODES.map((m) => (
                    <DropdownMenuRadioItem key={m.id} value={m.id} className="flex-col items-start gap-0">
                      <span className="font-medium">{m.label}</span>
                      <span className="text-xs text-muted-foreground">{m.hint}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Working directory (#152): where the harness process is spawned. */}
          <div className="mt-2 flex items-center gap-2">
            <label className="font-medium uppercase tracking-wide">directory</label>
            <Input
              className="h-7 flex-1 font-mono text-xs"
              value={ws.terminal.cwd ?? ""}
              key={`${ws.id}:cwd`}
              placeholder="~"
              spellCheck={false}
              onChange={(e) => project.patchTerminal(ws.id, { cwd: e.target.value.trim() || undefined })}
              title="Working directory the harness process is spawned in."
            />
            <DirectoryPicker value={ws.terminal.cwd} onChange={(path) => project.patchTerminal(ws.id, { cwd: path })} />
          </div>

          {/* Background context (#76): freeform "set the scene" priming, baked into
              the launch system-prompt so it steers every idea. */}
          <div className="mt-2">
            <div className="mb-1 flex items-center justify-between">
              <label htmlFor={`bg-${ws.id}`} className="font-medium uppercase tracking-wide">
                Background
              </label>
              <span className={cn("font-mono tabular-nums", overCap && "text-amber-600 dark:text-amber-500")}>
                {background.length}/{BACKGROUND_SOFT_CAP}
              </span>
            </div>
            <Textarea
              id={`bg-${ws.id}`}
              rows={1}
              className="max-h-[12rem] min-h-0 resize-y text-xs leading-snug"
              value={background}
              spellCheck={true}
              placeholder="e.g. We're a B2B fintech, audience is CFOs, avoid ideas needing new hardware."
              onChange={(e) => project.patchTerminal(ws.id, { background: e.target.value })}
            />
            <p className="mt-1 italic">Sets the scene for every idea. Locked once you start.</p>
          </div>
        </section>
      )}

      <section className="relative min-h-0 flex-1">
        {!attached && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-start gap-2 bg-background p-3 text-sm text-muted-foreground">
            No session yet. Start a session, then talk to the agent in the terminal; ideas land on the canvas.
          </div>
        )}
        <div className="block h-full">
          <Terminal />
        </div>
      </section>
    </div>
  );
}
