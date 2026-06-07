import { create } from 'zustand'
import { backend } from './backend.store'
import { canvas } from './canvas.store'
import { ingestion } from './ingestion.store'
import { framePrompt, type PromptIntent } from '../core/prompt-framing'
import type { TerminalConfig } from '../core/models'

export interface AgentRun {
  status: 'spawned' | 'running' | 'exit' | 'error'
  pid?: number
  output: string
  code?: number
}

/**
 * Input-layer context injection (PRD §3.2) and downstream agent hook (PRD §3.6).
 *
 * - `injectContext` serializes the active canvas to normalized text and pushes
 *   it into the workspace's terminal loop as structural memory.
 * - `dispatch` extracts plain block text and asks the backend to spawn the
 *   local orchestrator subprocess with the payload as a functional argument,
 *   streaming the run's lifecycle back into the store for the control hub.
 * - `discussText` is the bidirectional-canvas seam (#13): it types a framed,
 *   EDITABLE prompt into the live interactive session for the user to submit.
 *
 * 1:1 port of the Angular `AgentService`: the per-workspace run signals become
 * a `runs` record in this Zustand store.
 */

interface AgentState {
  runs: Record<string, AgentRun | null>
}

export const useAgentStore = create<AgentState>(() => ({ runs: {} }))

const subscribed = new Set<string>()

function setRun(workspaceId: string, run: AgentRun | null): void {
  useAgentStore.setState((s) => ({ runs: { ...s.runs, [workspaceId]: run } }))
}

function getRun(workspaceId: string): AgentRun | null {
  return useAgentStore.getState().runs[workspaceId] ?? null
}

function ensureSubscription(workspaceId: string): void {
  if (subscribed.has(workspaceId)) return
  subscribed.add(workspaceId)
  backend.subscribe(workspaceId, (msg) => {
    if (msg.type !== 'agent-status') return
    const cur = getRun(workspaceId) ?? { status: 'spawned', output: '' }
    switch (msg.status) {
      case 'spawned':
        setRun(workspaceId, { status: 'running', pid: msg.pid, output: '' })
        break
      case 'stdout':
      case 'stderr':
        setRun(workspaceId, { ...cur, status: 'running', output: cur.output + (msg.data ?? '') })
        break
      case 'exit':
        setRun(workspaceId, { ...cur, status: 'exit', code: msg.code })
        break
      case 'error':
        setRun(workspaceId, { ...cur, status: 'error', output: cur.output + (msg.data ?? '') })
        break
    }
  })
}

export const agent = {
  /** PRD §3.2 — inject serialized whiteboard state into the terminal loop. */
  injectContext(workspaceId: string): string {
    const document = canvas.serializeToText(workspaceId)
    backend.send({ type: 'context', workspaceId, document: document + '\n' })
    return document
  },

  /**
   * PRD §3.6 — dispatch the selected block text to the local agent orchestrator.
   * `payloadOverride` lets callers pass explicit text (e.g. a block-level macro);
   * otherwise the current editor selection is used.
   */
  dispatch(workspaceId: string, config: TerminalConfig, payloadOverride?: string): void {
    const selection = (payloadOverride ?? canvas.getSelectedText()).trim()
    if (!selection) return
    const command = config.agentCommand?.trim() || 'claude'

    // PRD §3.2 — automatically inject the serialized canvas as structural memory
    // so the agent receives the full whiteboard context, not just the selected
    // blocks. The selection is called out as the active focus.
    const context = canvas.serializeToText(workspaceId)
    const payload = context
      ? `# Workspace context\n\n${context}\n\n# Selected focus\n\n${selection}`
      : selection

    ensureSubscription(workspaceId)
    setRun(workspaceId, { status: 'spawned', output: '' })

    backend.connect()
    backend.send({
      type: 'agent',
      workspaceId,
      command,
      args: config.agentArgs ?? [],
      payload,
      cwd: config.cwd,
    })
  },

  /**
   * Bidirectional canvas (#13) — feed the given canvas text into the LIVE
   * interactive terminal session as an EDITABLE prompt (no trailing newline, so
   * the cursor lands ready for the user to edit and submit it themselves).
   *
   * @returns `true` if a prompt was typed; `false` if no session is attached or
   *   the text is empty.
   */
  discussText(
    workspaceId: string,
    text: string,
    intent: PromptIntent = 'discuss',
    sourceRef?: string,
  ): boolean {
    if (!ingestion.isAttached(workspaceId)) return false
    const prompt = framePrompt(text.trim() ? text : '', intent, sourceRef)
    if (!prompt) return false
    // No '\r': the prompt stays editable in the terminal until the user submits.
    ingestion.sendInput(workspaceId, prompt)
    ingestion.focusTerminal(workspaceId)
    return true
  },
}
