/**
 * Tests for agent.discussText — the bidirectional canvas seam (#13).
 *
 * When a session is attached, the supplied card text is framed and TYPED into
 * the live PTY as an editable prompt (no trailing '\r', so not auto-submitted)
 * and the terminal is focused. When nothing is attached, or the text is empty,
 * nothing is sent. Ported from the Angular spec; collaborator stores are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Harness {
  agent: typeof import('./agent.store').agent
  sendInput: ReturnType<typeof vi.fn>
  focusTerminal: ReturnType<typeof vi.fn>
}

async function makeStore(opts: { attached: boolean }): Promise<Harness> {
  vi.resetModules()
  const sendInput = vi.fn()
  const focusTerminal = vi.fn()
  vi.doMock('./ingestion.store', () => ({
    ingestion: { isAttached: (_id: string) => opts.attached, sendInput, focusTerminal },
  }))
  // backend.store reads `location` at import time; canvas pulls in tldraw — mock
  // both so the agent store imports cleanly in the Node test env.
  vi.doMock('./backend.store', () => ({ backend: {} }))
  vi.doMock('./canvas.store', () => ({ canvas: {} }))

  const { agent } = await import('./agent.store')
  return { agent, sendInput, focusTerminal }
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
