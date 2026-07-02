/**
 * Tests for agent.discussText — the bidirectional canvas seam (#13).
 *
 * When a session is attached, the supplied card text is framed and TYPED into
 * the live PTY as an editable prompt (no trailing '\r', so not auto-submitted)
 * and the terminal is focused. When nothing is attached, or the text is empty,
 * nothing is sent. Ported from the Angular spec; collaborator stores are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ServerMessage } from '@ai-storm/shared'

interface Harness {
  agent: typeof import('./agent.store').agent
  useAgentStore: typeof import('./agent.store').useAgentStore
  sendInput: ReturnType<typeof vi.fn>
  focusTerminal: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  /** Push a backend message to the store's workspace subscription. */
  receive: (msg: ServerMessage) => void
}

async function makeStore(opts: { attached: boolean }): Promise<Harness> {
  vi.resetModules()
  const sendInput = vi.fn()
  const focusTerminal = vi.fn()
  const send = vi.fn()
  const handlers: Array<(msg: ServerMessage) => void> = []
  vi.doMock('./ingestion.store', () => ({
    ingestion: { isAttached: (_id: string) => opts.attached, sendInput, focusTerminal },
  }))
  // backend.store reads `location` at import time; canvas pulls in tldraw — mock
  // both so the agent store imports cleanly in the Node test env.
  vi.doMock('./backend.store', () => ({
    backend: {
      connect: vi.fn(),
      send,
      subscribe: (_id: string, h: (msg: ServerMessage) => void) => {
        handlers.push(h)
        return () => {}
      },
    },
  }))
  vi.doMock('./canvas.store', () => ({
    canvas: { serializeForHandoff: () => '★ [feature] Dark mode — the one card' },
  }))

  const { agent, useAgentStore } = await import('./agent.store')
  return {
    agent,
    useAgentStore,
    sendInput,
    focusTerminal,
    send,
    receive: (msg) => handlers.forEach((h) => h(msg)),
  }
}

describe('agent.discussText (#13)', () => {
  let h: Harness

  describe('attached with non-empty text', () => {
    beforeEach(async () => {
      h = await makeStore({ attached: true })
    })

    it('returns true', () => {
      expect(h.agent.discussText('ws1', 'Cache CRDT ops offline')).toBe(true)
    })

    it('types the framed prompt into the PTY with NO trailing carriage return', () => {
      h.agent.discussText('ws1', 'Cache CRDT ops offline')
      expect(h.sendInput).toHaveBeenCalledTimes(1)
      const [id, data] = h.sendInput.mock.calls[0]
      expect(id).toBe('ws1')
      expect(data).toContain('Cache CRDT ops offline')
      expect(data.endsWith('\r')).toBe(false)
      expect(data.endsWith('\n')).toBe(false)
      expect(data.endsWith(' ')).toBe(true)
    })

    it('focuses the terminal after typing the prompt', () => {
      h.agent.discussText('ws1', 'Cache CRDT ops offline')
      expect(h.focusTerminal).toHaveBeenCalledWith('ws1')
    })
  })

  describe('not attached', () => {
    beforeEach(async () => {
      h = await makeStore({ attached: false })
    })

    it('returns false and sends nothing', () => {
      expect(h.agent.discussText('ws1', 'some notes')).toBe(false)
      expect(h.sendInput).not.toHaveBeenCalled()
      expect(h.focusTerminal).not.toHaveBeenCalled()
    })
  })

  describe('attached but empty text', () => {
    beforeEach(async () => {
      h = await makeStore({ attached: true })
    })

    it('returns false and sends nothing', () => {
      expect(h.agent.discussText('ws1', '   \n  ')).toBe(false)
      expect(h.sendInput).not.toHaveBeenCalled()
      expect(h.focusTerminal).not.toHaveBeenCalled()
    })
  })
})

describe('agent.generateSpec run metadata + capabilities (#120)', () => {
  const config = { agentCommand: 'claude', agentArgs: [], cwd: '/repo' } as never

  let h: Harness
  beforeEach(async () => {
    h = await makeStore({ attached: true })
  })

  it('sends the format and an empty capability list by default', () => {
    expect(h.agent.generateSpec('ws1', config, 'plan')).toBe(true)
    expect(h.send).toHaveBeenCalledTimes(1)
    const msg = h.send.mock.calls[0][0]
    expect(msg.type).toBe('agent')
    expect(msg.format).toBe('plan')
    expect(msg.capabilities).toEqual([])
  })

  it('requests the create-issues capability when the issues create-toggle is on', () => {
    h.agent.generateSpec('ws1', config, 'issues', { createIssues: true })
    const msg = h.send.mock.calls[0][0]
    expect(msg.format).toBe('issues')
    expect(msg.capabilities).toEqual(['create-issues'])
  })

  it('adopts the backend-echoed format on spawned (survives a stateless client)', () => {
    h.agent.generateSpec('ws1', config, 'prd')
    // Simulate a client whose local stamp is gone: spawned carries the format.
    h.useAgentStore.setState({ runs: {} })
    h.receive({ type: 'agent-status', workspaceId: 'ws1', status: 'spawned', pid: 1, format: 'issues' })
    expect(h.useAgentStore.getState().runs['ws1']?.format).toBe('issues')
  })

  it('applies agent-artifacts to the run and keeps them through exit', () => {
    h.agent.generateSpec('ws1', config, 'issues', { createIssues: true })
    h.receive({ type: 'agent-status', workspaceId: 'ws1', status: 'spawned', pid: 1, format: 'issues' })
    const artifacts = [
      { kind: 'github-issue' as const, title: 'Add dark mode', url: 'https://github.com/acme/app/issues/12' },
    ]
    h.receive({ type: 'agent-artifacts', workspaceId: 'ws1', artifacts })
    h.receive({ type: 'agent-status', workspaceId: 'ws1', status: 'exit', code: 0 })
    const run = h.useAgentStore.getState().runs['ws1']
    expect(run?.status).toBe('exit')
    expect(run?.artifacts).toEqual(artifacts)
  })
})
