/**
 * Tests for the ingestion split (extraction-contract §8.1):
 *  - `data` → the registered terminal sink (the xterm.js conversation surface),
 *             buffered until a terminal mounts, then flushed.
 *  - `idea` → canvas.applyIdeas via the render scheduler.
 *
 * Ported from the Angular spec. The collaborator stores (canvas, backend,
 * workspace) are mocked so the store runs in the plain Node test env; a fresh
 * module instance per test (`vi.resetModules()`) keeps the singleton's pipeline
 * maps isolated between cases.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Listener = (msg: unknown) => void

/** The render scheduler flushes on a ~16ms setTimeout frame in Node. */
const nextFrame = () => new Promise((r) => setTimeout(r, 25))

async function makeStore() {
  vi.resetModules()
  const applyIdeas = vi.fn()
  let listener: Listener | null = null
  vi.doMock('./canvas.store', () => ({ canvas: { applyIdeas } }))
  vi.doMock('./backend.store', () => ({
    backend: {
      subscribe: (_id: string, cb: Listener) => {
        listener = cb
        return () => {}
      },
      onOpen: () => () => {},
      connect: () => {},
      send: () => {},
    },
  }))
  vi.doMock('./workspace.store', () => ({ workspace: { setStatus: vi.fn() } }))

  const { ingestion } = await import('./ingestion.store')
  ingestion.attach('ws1', { agentCommand: 'claude' } as never)
  const emitIdea = (idea: { title: string; body: string; kind?: string }) =>
    listener?.({ type: 'idea', workspaceId: 'ws1', idea })
  const emitData = (data: string) => listener?.({ type: 'data', workspaceId: 'ws1', data })
  return { ingestion, applyIdeas, emitIdea, emitData }
}

describe('ingestion store — data/idea split', () => {
  let h: Awaited<ReturnType<typeof makeStore>>
  beforeEach(async () => {
    h = await makeStore()
  })

  it('routes an idea to the canvas (applyIdeas) and never to the terminal', async () => {
    const write = vi.fn()
    h.ingestion.registerTerminal('ws1', { write, clear: vi.fn() })

    const idea = { title: 'Offline-first canvas', body: 'cache CRDT ops' }
    h.emitIdea(idea)
    await nextFrame()

    expect(h.applyIdeas).toHaveBeenCalledTimes(1)
    expect(h.applyIdeas).toHaveBeenCalledWith('ws1', [idea])
    expect(write).not.toHaveBeenCalled()
  })

  it('forwards raw data to a registered terminal sink and not to the canvas', () => {
    const write = vi.fn()
    h.ingestion.registerTerminal('ws1', { write, clear: vi.fn() })

    h.emitData('aGVsbG8=')
    expect(write).toHaveBeenCalledWith('aGVsbG8=')
    expect(h.applyIdeas).not.toHaveBeenCalled()
  })

  it('buffers data that arrives before the terminal mounts, then flushes on register', () => {
    h.emitData('Zmlyc3Q=') // "first"
    h.emitData('c2Vjb25k') // "second"

    const write = vi.fn()
    h.ingestion.registerTerminal('ws1', { write, clear: vi.fn() })

    expect(write.mock.calls.map((c) => c[0])).toEqual(['Zmlyc3Q=', 'c2Vjb25k'])
  })

  it('clearTerminal delegates to the registered sink', () => {
    const clear = vi.fn()
    h.ingestion.registerTerminal('ws1', { write: vi.fn(), clear })
    h.ingestion.clearTerminal('ws1')
    expect(clear).toHaveBeenCalledTimes(1)
  })
})
