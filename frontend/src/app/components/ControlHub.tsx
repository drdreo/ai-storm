import { useEffect } from 'react'
import * as Toolbar from '@radix-ui/react-toolbar'
import { ChevronDown } from 'lucide-react'
import { FACILITATION_MODES, getFacilitationMode } from '@ai-storm/shared'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useWorkspaceStore, selectActive, workspace } from '../stores/workspace.store'
import { useIngestionStore, ingestion } from '../stores/ingestion.store'
import { useAgentStore } from '../stores/agent.store'
import { useBackendStore } from '../stores/backend.store'
import { Terminal } from './Terminal'

const CONN_DOT: Record<string, string> = {
  open: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  closed: 'bg-destructive',
}

/**
 * Conversational Control Hub (PRD §3.1). The conversation surface is a real
 * terminal (xterm.js, fed the raw PTY stream — see Terminal), so this shell
 * provides the session controls, the harness selector, the downstream agent run
 * output, and diagnostic readouts of the background connection.
 */
export function ControlHub() {
  const ws = useWorkspaceStore(selectActive)
  const connState = useBackendStore((s) => s.state)
  const attached = useIngestionStore((s) => (ws ? !!s.attached[ws.id] : false))
  const agentRun = useAgentStore((s) => (ws ? s.runs[ws.id] ?? null : null))

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
              <Button size="sm" onClick={() => ingestion.attach(ws.id, ws.terminal)}>
                Start session
              </Button>
            </Toolbar.Button>
          )}
          <Toolbar.Button asChild>
            <Button size="sm" variant="outline" onClick={() => ingestion.clearTerminal(ws.id)}>
              Clear
            </Button>
          </Toolbar.Button>
        </Toolbar.Root>
      </header>

      <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
        <label className="font-medium uppercase tracking-wide">harness</label>
        <Input
          className="h-7 w-44 font-mono text-xs"
          defaultValue={harness}
          key={`${ws.id}:${harness}`}
          disabled={attached}
          placeholder="claude"
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
          <DropdownMenuTrigger asChild disabled={attached}>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-7 gap-1 font-mono text-xs"
              title="Facilitation mode — how the agent ideates (#61). Applied on session start."
            >
              {mode.label}
              <ChevronDown className="size-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={mode.id}
              onValueChange={(id) => workspace.patchTerminal(ws.id, { mode: id })}
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

      {agentRun && (
        <section className="max-h-[35%] overflow-y-auto border-t">
          <div className="sticky top-0 flex items-center justify-between border-b bg-card px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>agent: {harness}</span>
            <Badge
              variant={
                agentRun.status === 'error'
                  ? 'destructive'
                  : agentRun.status === 'exit'
                    ? 'secondary'
                    : 'default'
              }
              className="uppercase"
            >
              {agentRun.status}
              {agentRun.code !== undefined ? ` (${agentRun.code})` : ''}
            </Badge>
          </div>
          {agentRun.output && (
            <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-xs">
              {agentRun.output}
            </pre>
          )}
        </section>
      )}
    </div>
  )
}
