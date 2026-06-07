import { useEffect } from 'react'
import * as Toolbar from '@radix-ui/react-toolbar'
import { useWorkspaceStore, selectActive, workspace } from '../stores/workspace.store'
import { useIngestionStore, ingestion } from '../stores/ingestion.store'
import { useAgentStore } from '../stores/agent.store'
import { useBackendStore } from '../stores/backend.store'

/**
 * Conversational Control Hub (PRD §3.1). The conversation surface is a real
 * terminal (xterm.js, fed the raw PTY stream — see Terminal), so this shell
 * provides the session controls, the harness selector, the downstream agent run
 * output, and diagnostic readouts of the background connection. Ideas land on
 * the canvas, not here.
 */
import { Terminal } from './Terminal'

export function ControlHub() {
  const ws = useWorkspaceStore(selectActive)
  const connState = useBackendStore((s) => s.state)
  const attached = useIngestionStore((s) => (ws ? !!s.attached[ws.id] : false))
  const agentRun = useAgentStore((s) => (ws ? s.runs[ws.id] ?? null : null))

  // Resume a durable session after a reload / hot-switch (PRD §3.5). A page
  // reload loses the client-side pipeline but the named backend session
  // survives, so on (re)activation we re-attach to it. We gate on the persisted
  // live status ('active' / 'streaming') as the proxy for "this workspace had a
  // session", so merely visiting a never-started workspace does not spawn a
  // harness. `attach` is idempotent: it reconnects rather than respawning.
  useEffect(() => {
    if (!ws) return
    const wasLive = ws.status === 'active' || ws.status === 'streaming'
    if (wasLive && !ingestion.isAttached(ws.id)) {
      ingestion.attach(ws.id, ws.terminal)
    }
  }, [ws, attached])

  if (!ws) return null

  const harness = ws.terminal.agentCommand || 'claude'

  const setHarness = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value.trim()
    workspace.patchTerminal(ws.id, { agentCommand: value || 'claude' })
  }

  const sessionBtn =
    'rounded-md border border-border-strong bg-btn px-3 py-1.5 text-[0.76rem] font-semibold text-text-dim transition-colors hover:bg-btn-hover hover:text-text active:translate-y-px focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-ring'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-border-strong bg-panel p-3 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2 text-[0.7rem] font-semibold uppercase tracking-[0.05em] text-text-dim">
          <span className="as-conn" data-state={connState} />
          <span>{connState}</span>
          <span className="opacity-35">·</span>
          <span>{ws.status}</span>
        </div>
        <Toolbar.Root
          className="flex gap-2 focus:outline-none"
          orientation="horizontal"
          aria-label="Session controls"
        >
          {attached ? (
            <Toolbar.Button
              className={`${sessionBtn} !border-[color-mix(in_srgb,var(--danger)_35%,var(--border-strong))] !text-danger hover:!bg-[color-mix(in_srgb,var(--danger)_14%,var(--btn-bg))]`}
              onClick={() => ingestion.kill(ws.id)}
            >
              Stop
            </Toolbar.Button>
          ) : (
            <Toolbar.Button
              className={`${sessionBtn} !border-[color-mix(in_srgb,var(--ok)_35%,var(--border-strong))] !text-ok hover:!bg-[color-mix(in_srgb,var(--ok)_14%,var(--btn-bg))]`}
              onClick={() => ingestion.attach(ws.id, ws.terminal)}
            >
              Start session
            </Toolbar.Button>
          )}
          <Toolbar.Button className={sessionBtn} onClick={() => ingestion.clearTerminal(ws.id)}>
            Clear
          </Toolbar.Button>
        </Toolbar.Root>
      </header>

      <div className="flex items-center gap-2 border-b border-border-base bg-sidebar px-3 py-2 text-[0.7rem] text-text-faint">
        <label className="font-semibold uppercase tracking-[0.05em]">harness</label>
        <input
          className="w-[180px] flex-none rounded-md border border-border-strong bg-input px-[0.55rem] py-[0.3rem] font-mono text-[0.76rem] text-text transition-colors hover:border-accent focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent-ring disabled:opacity-50"
          defaultValue={harness}
          key={`${ws.id}:${harness}`}
          disabled={attached}
          placeholder="claude"
          spellCheck={false}
          onChange={setHarness}
          title="The AI CLI launched for this workspace's session (PRD §2). Keystrokes are sent to its PTY."
        />
        <span className="italic opacity-70">
          a real terminal — type directly; ideas land on the canvas
        </span>
      </div>

      <section className="relative min-h-0 flex-1 bg-bg">
        {!attached && (
          <div className="pointer-events-none absolute inset-0 z-[1] flex flex-col items-start gap-2 bg-bg p-3 font-sans text-[0.82rem] leading-relaxed text-text-faint before:font-mono before:text-[1.1rem] before:text-accent before:opacity-70 before:content-['~']">
            No session yet. Start a session, then talk to the agent in the terminal; ideas land
            on the canvas.
          </div>
        )}
        <div className="block h-full">
          <Terminal />
        </div>
      </section>

      {agentRun && (
        <section className="max-h-[35%] overflow-y-auto border-t border-border-strong bg-sidebar">
          <div className="sticky top-0 flex items-center justify-between border-b border-border-base bg-panel px-3 py-2 text-[0.7rem] font-semibold tracking-[0.03em] text-text-dim">
            <span>agent: {harness}</span>
            <span
              className="text-[0.66rem] uppercase tracking-[0.05em] data-[state=error]:text-danger data-[state=exit]:text-ok data-[state=running]:text-accent"
              data-state={agentRun.status}
            >
              {agentRun.status}
              {agentRun.code !== undefined ? ` (${agentRun.code})` : ''}
            </span>
          </div>
          {agentRun.output && (
            <pre className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-[0.74rem] leading-relaxed text-text">
              {agentRun.output}
            </pre>
          )}
        </section>
      )}
    </div>
  )
}
