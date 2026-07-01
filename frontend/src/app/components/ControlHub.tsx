import { useEffect } from 'react'
import * as Toolbar from '@radix-ui/react-toolbar'
import { ChevronDown, PanelRightClose } from 'lucide-react'
import { FACILITATION_MODES, getFacilitationMode } from '@ai-storm/shared'
import { Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useWorkspaceStore, selectActive, workspace } from '../stores/workspace.store'
import { useIngestionStore, ingestion } from '../stores/ingestion.store'
import { useBackendStore } from '../stores/backend.store'
import { computeReadiness, hasBlockingIssues, type ReadinessSeverity } from '../core/readiness'
import { Terminal } from './Terminal'

const CONN_DOT: Record<string, string> = {
  open: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  closed: 'bg-destructive',
}

const READINESS_DOT: Record<ReadinessSeverity, string> = {
  ok: 'bg-emerald-500',
  warning: 'bg-amber-500',
  blocking: 'bg-destructive',
}

/**
 * Soft cap on the background context (#76). Not enforced — the textarea rides
 * every turn's prompt, so past the cap the counter turns amber to nudge the user
 * toward something the agent can actually keep in view, rather than blocking.
 */
const BACKGROUND_SOFT_CAP = 1500

/**
 * Conversational Control Hub (PRD §3.1). The conversation surface is a real
 * terminal (xterm.js, fed the raw PTY stream — see Terminal), so this shell
 * provides the session controls, the harness selector, and diagnostic readouts
 * of the background connection.
 */
export function ControlHub({ onCollapse }: { onCollapse?: () => void }) {
  const ws = useWorkspaceStore(selectActive)
  const connState = useBackendStore((s) => s.state)
  const attached = useIngestionStore((s) => (ws ? !!s.attached[ws.id] : false))
  const sessionError = useIngestionStore((s) => (ws ? s.errors[ws.id] ?? null : null))

  // Resume a durable session after a reload / hot-switch (PRD §3.5). `attach` is
  // idempotent: it reconnects to the surviving backend session rather than
  // respawning it. Gated on the persisted live status so visiting a never-started
  // workspace does not spawn a harness.
  useEffect(() => {
    if (!ws) return
    const wasLive = ws.status === 'active' || ws.status === 'streaming'
    if (wasLive && !ingestion.isAttached(ws.id)) {
      ingestion.attach(ws.id, ws.terminal)
    }
  }, [ws, attached])

  if (!ws) return null

  const harness = ws.terminal.agentCommand || 'claude'
  const mode = getFacilitationMode(ws.terminal.mode)
  const background = ws.terminal.background ?? ''
  const overCap = background.length > BACKGROUND_SOFT_CAP

  const readiness = computeReadiness({
    connState,
    agentCommand: harness,
    cwd: ws.terminal.cwd,
    modeId: ws.terminal.mode,
    background,
  })
  const blocked = hasBlockingIssues(readiness)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <span className={cn('size-2 rounded-full', CONN_DOT[connState])} />
          <span>{connState}</span>
          <span className="opacity-40">·</span>
          <span>{ws.status}</span>
        </div>
        <Toolbar.Root className="flex gap-2" aria-label="Session controls">
          {attached ? (
            <Toolbar.Button asChild>
              <Button size="sm" variant="destructive" onClick={() => ingestion.kill(ws.id)}>
                Stop
              </Button>
            </Toolbar.Button>
          ) : (
            <Toolbar.Button asChild>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button
                      size="sm"
                      disabled={blocked}
                      onClick={() => ingestion.attach(ws.id, ws.terminal)}
                    >
                      Start session
                    </Button>
                  </span>
                </TooltipTrigger>
                {blocked && (
                  <TooltipContent>Resolve the blocking readiness checks below to start.</TooltipContent>
                )}
              </Tooltip>
            </Toolbar.Button>
          )}
          <Toolbar.Button asChild>
            <Button size="sm" variant="outline" onClick={() => ingestion.clearTerminal(ws.id)}>
              Clear
            </Button>
          </Toolbar.Button>
          {onCollapse && (
            <Toolbar.Button asChild>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="Collapse control hub"
                    onClick={onCollapse}
                  >
                    <PanelRightClose className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Collapse control hub</TooltipContent>
              </Tooltip>
            </Toolbar.Button>
          )}
        </Toolbar.Root>
      </header>

      {/* Last backend error (e.g. a harness that couldn't be launched). Shown
          here, not just as a status dot, so the user can read *why* and act on
          it — and dismiss it once handled. */}
      {sessionError && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-medium">
            {sessionError}
          </span>
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

      {/* Readiness checklist (#97): best-effort setup checks so common
          start-up failures (no backend connection, blank harness) surface
          before Start rather than after a failed launch. Only shown while
          detached — once attached, sessionError above covers failures. */}
      {!attached && (
        <ul
          aria-label="Session readiness"
          className="flex flex-wrap gap-x-4 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground"
        >
          {readiness.map((check) => (
            <li key={check.id} className="flex items-center gap-1.5" title={check.detail}>
              <span className={cn('size-1.5 rounded-full', READINESS_DOT[check.severity])} />
              <span className={cn(check.severity === 'blocking' && 'font-medium text-destructive')}>
                {check.label}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Session setup (#76): harness + facilitation mode + background context.
          All three are baked into the launch system-prompt, so they share one
          rule — editable before start, locked once the session is live. The
          always-visible "applied on start" / "session live" tag is the key cue;
          the hover tooltip carries the *how* (Stop & Start to apply edits). */}
      <section className="border-b px-3 py-2 text-xs text-muted-foreground">
        <div className="mb-2 flex items-center gap-2">
          {attached ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="flex items-center gap-1 font-medium uppercase tracking-wide text-amber-600 dark:text-amber-500">
                    <Lock className="size-3" />
                    session live
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  Stop to edit setup. Baked in at launch — background, mode &amp; harness define the
                  session and can&apos;t change while it&apos;s live. Stop &amp; Start to apply edits.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <span className="font-medium uppercase tracking-wide">Session setup · applied on start</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="font-medium uppercase tracking-wide">harness</label>
          <Input
            className="h-7 w-44 font-mono text-xs"
            defaultValue={harness}
            key={`${ws.id}:${attached}`}
            disabled={attached}
            placeholder="claude, pi, or codex"
            spellCheck={false}
            onChange={(e) =>
              workspace.patchTerminal(ws.id, { agentCommand: e.target.value.trim() || 'claude' })
            }
            title="The AI CLI launched for this workspace's session (PRD §2). Keystrokes are sent to its PTY."
          />
          <span className="truncate italic">{mode.hint}</span>
          {/* Facilitation mode picker (#61): swaps the priming preset the agent is
              launched with. Baked at launch, so it's locked while attached —
              Stop & Start to switch how the agent ideates. */}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild disabled={attached}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7 gap-1 font-mono text-xs"
                  >
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
                onValueChange={(id) => workspace.patchTerminal(ws.id, { mode: id })}
              >
                {FACILITATION_MODES.map((m) => (
                  <DropdownMenuRadioItem
                    key={m.id}
                    value={m.id}
                    className="flex-col items-start gap-0"
                  >
                    <span className="font-medium">{m.label}</span>
                    <span className="text-xs text-muted-foreground">{m.hint}</span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Background context (#76): freeform "set the scene" priming, baked into
            the launch system-prompt so it steers every idea — hence locked while
            attached, exactly like harness and mode. */}
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between">
            <label htmlFor={`bg-${ws.id}`} className="font-medium uppercase tracking-wide">
              Background
            </label>
            <span className={cn('font-mono tabular-nums', overCap && 'text-amber-600 dark:text-amber-500')}>
              {background.length}/{BACKGROUND_SOFT_CAP}
            </span>
          </div>
          <Textarea
            id={`bg-${ws.id}`}
            rows={1}
            className="max-h-[12rem] min-h-0 resize-y text-xs leading-snug"
            value={background}
            disabled={attached}
            spellCheck={true}
            placeholder="e.g. We're a B2B fintech, audience is CFOs, avoid ideas needing new hardware."
            onChange={(e) => workspace.patchTerminal(ws.id, { background: e.target.value })}
            title={
              attached
                ? 'Baked in at launch. Stop & Start to edit the background context.'
                : undefined
            }
          />
          <p className="mt-1 italic">Sets the scene for every idea. Locked once you start.</p>
        </div>
      </section>

      <section className="relative min-h-0 flex-1">
        {!attached && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-start gap-2 bg-background p-3 text-sm text-muted-foreground">
            No session yet. Start a session, then talk to the agent in the terminal; ideas land
            on the canvas.
          </div>
        )}
        <div className="block h-full">
          <Terminal />
        </div>
      </section>
    </div>
  )
}
