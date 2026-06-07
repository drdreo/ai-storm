import { useEffect, useMemo, useState } from 'react'
import * as Toolbar from '@radix-ui/react-toolbar'
import { useWorkspaceStore, selectActive } from '../stores/workspace.store'
import { useCanvasStore, canvas } from '../stores/canvas.store'
import { agent } from '../stores/agent.store'
import { kindLabel } from '../core/idea-descriptors'
import { CanvasIsland } from '../core/canvas-island'

/**
 * Structural Workspace Canvas (PRD §3.1, §4.1). Hosts the tldraw canvas (the
 * React {@link CanvasIsland}) as the single spatial surface (PD-011: no
 * document/page view). The pane is just a toolbar — kind filters (#21) and the
 * agent macros (PRD §3.6) — over the canvas, which it renders directly (the old
 * Angular CanvasService facade is gone; PD-016).
 */
export function CanvasPane() {
  const active = useWorkspaceStore(selectActive)
  const ideasTick = useCanvasStore((s) => s.ideasTick)
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(new Set())

  // Bidirectional canvas (#13, #15): the card verbs (Discuss / Expand /
  // Challenge / Find risks) live on the selected idea card's action bar. When
  // one fires, frame the card's text for that intent and type it into the active
  // workspace's live terminal as an editable prompt. Registered once; reads the
  // latest active workspace from the store at fire time.
  useEffect(() => {
    canvas.onCardVerb((text, intent, sourceRef) => {
      const ws = selectActive(useWorkspaceStore.getState())
      if (ws) agent.discussText(ws.id, text, intent, sourceRef)
    })
  }, [])

  // React to workspace switches — rebind the tldraw island (PRD §3.4). Done at
  // render time (idempotent) so the controller's active id is set BEFORE the
  // freshly-keyed CanvasIsland mounts and `onEditorMount` drains its queue.
  if (active) canvas.switchTo(active.id)

  /**
   * Distinct idea kinds present on the active workspace's canvas (#21), one
   * filter chip each. Recomputes when a new batch of cards lands (canvas bumps
   * `ideasTick`) or the active workspace changes.
   */
  const kinds = useMemo<string[]>(() => {
    void ideasTick
    return active ? canvas.kindsPresent(active.id) : []
  }, [ideasTick, active])

  const toggleKind = (kind: string) => {
    if (!active) return
    const hidden = new Set(hiddenKinds)
    const willHide = !hidden.has(kind)
    if (willHide) hidden.add(kind)
    else hidden.delete(kind)
    setHiddenKinds(hidden)
    canvas.setKindVisible(active.id, kind, !willHide)
  }

  const arrange = () => active && canvas.arrange(active.id)
  const markSelected = () => active && canvas.markSelected(active.id)
  const selectMarked = () => active && canvas.selectMarked(active.id)
  const injectContext = () => active && agent.injectContext(active.id)
  const dispatchSelection = () => active && agent.dispatch(active.id, active.terminal)

  const actionBtn =
    'rounded-lg border border-border-strong px-[0.8rem] py-[0.42rem] text-[0.8rem] font-medium transition-all active:translate-y-px focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-ring'
  const ghost = `${actionBtn} bg-btn text-text-dim hover:bg-btn-hover hover:text-text`

  return (
    <div className="flex h-full flex-col">
      <div className="z-[2] flex items-center justify-end gap-2 border-b border-border-strong bg-panel px-3 py-2 shadow-[var(--shadow-sm)]">
        {kinds.length > 0 && (
          <div
            className="mr-auto flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Filter cards by kind"
          >
            {kinds.map((kind) => {
              const off = hiddenKinds.has(kind)
              return (
                <button
                  key={kind}
                  type="button"
                  className={`rounded-lg border border-border-strong px-[0.6rem] py-[0.28rem] text-[0.75rem] font-medium text-text transition-all hover:bg-btn-hover focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-accent-ring ${off ? 'bg-input text-text-dim opacity-60' : 'bg-raised'}`}
                  aria-pressed={!off}
                  onClick={() => toggleKind(kind)}
                  title={`Toggle ${kindLabel(kind)} cards on the canvas (#21)`}
                >
                  {kindLabel(kind)}
                </button>
              )
            })}
          </div>
        )}
        <Toolbar.Root
          className="flex gap-2 focus:outline-none"
          orientation="horizontal"
          aria-label="Canvas actions"
        >
          <Toolbar.Button className={ghost} onClick={arrange} title="Tidy cards into per-kind groups (#16)">
            ⤳ Arrange
          </Toolbar.Button>
          <Toolbar.Button
            className={ghost}
            onClick={markSelected}
            title="Mark/unmark the selected cards to keep for later (#29)"
          >
            ★ Mark
          </Toolbar.Button>
          <Toolbar.Button className={ghost} onClick={selectMarked} title="Select all marked cards (#29)">
            Select marked
          </Toolbar.Button>
          <Toolbar.Button
            className={ghost}
            onClick={injectContext}
            title="Serialize canvas into the terminal loop (PRD 3.2)"
          >
            Inject context
          </Toolbar.Button>
          <Toolbar.Button
            className={`${actionBtn} bg-accent font-semibold text-on-accent [box-shadow:var(--shadow-sm),inset_0_1px_0_rgba(255,255,255,0.18)] hover:bg-accent-hover active:bg-accent-press`}
            onClick={dispatchSelection}
            title="Send selection to the local agent (PRD 3.6)"
          >
            Send to agent ▸
          </Toolbar.Button>
        </Toolbar.Root>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-canvas">
        {active && <CanvasIsland key={active.id} workspaceId={active.id} bridge={canvas.bridge} />}
      </div>
    </div>
  )
}
