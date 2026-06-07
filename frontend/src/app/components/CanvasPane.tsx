import { useEffect, useMemo, useState } from 'react'
import * as Toolbar from '@radix-ui/react-toolbar'
import { Button } from '@/components/ui/button'
import { useWorkspaceStore, selectActive } from '../stores/workspace.store'
import { useCanvasStore, canvas } from '../stores/canvas.store'
import { agent } from '../stores/agent.store'
import { kindLabel } from '../core/idea-descriptors'
import { CanvasIsland } from '../core/canvas-island'

/**
 * Structural Workspace Canvas (PRD §3.1, §4.1). Hosts the tldraw canvas (the
 * React {@link CanvasIsland}) as the single spatial surface (PD-011). The pane
 * is a shadcn toolbar — kind filters (#21) and the agent macros (PRD §3.6) —
 * over the canvas, which it renders directly (PD-016).
 */
export function CanvasPane() {
  const active = useWorkspaceStore(selectActive)
  const ideasTick = useCanvasStore((s) => s.ideasTick)
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(new Set())

  // Bidirectional canvas (#13, #15): when a card verb fires, frame the card's
  // text and type it into the active workspace's live terminal. Registered once;
  // reads the latest active workspace at fire time.
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

  return (
    <div className="flex h-full flex-col">
      <div className="z-[2] flex items-center justify-end gap-2 border-b bg-background px-3 py-2">
        {kinds.length > 0 && (
          <div className="mr-auto flex flex-wrap items-center gap-1" role="group" aria-label="Filter cards by kind">
            {kinds.map((kind) => {
              const off = hiddenKinds.has(kind)
              return (
                <Button
                  key={kind}
                  size="sm"
                  variant={off ? 'outline' : 'secondary'}
                  aria-pressed={!off}
                  className="h-7"
                  onClick={() => toggleKind(kind)}
                  title={`Toggle ${kindLabel(kind)} cards on the canvas (#21)`}
                >
                  {kindLabel(kind)}
                </Button>
              )
            })}
          </div>
        )}
        <Toolbar.Root className="flex gap-2" aria-label="Canvas actions">
          <Toolbar.Button asChild>
            <Button size="sm" variant="ghost" onClick={arrange} title="Tidy cards into per-kind groups (#16)">
              ⤳ Arrange
            </Button>
          </Toolbar.Button>
          <Toolbar.Button asChild>
            <Button size="sm" variant="ghost" onClick={markSelected} title="Mark/unmark the selected cards (#29)">
              ★ Mark
            </Button>
          </Toolbar.Button>
          <Toolbar.Button asChild>
            <Button size="sm" variant="ghost" onClick={selectMarked} title="Select all marked cards (#29)">
              Select marked
            </Button>
          </Toolbar.Button>
          <Toolbar.Button asChild>
            <Button size="sm" variant="ghost" onClick={injectContext} title="Serialize canvas into the terminal loop (PRD 3.2)">
              Inject context
            </Button>
          </Toolbar.Button>
          <Toolbar.Button asChild>
            <Button size="sm" onClick={dispatchSelection} title="Send selection to the local agent (PRD 3.6)">
              Send to agent ▸
            </Button>
          </Toolbar.Button>
        </Toolbar.Root>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-white">
        {active && <CanvasIsland key={active.id} workspaceId={active.id} bridge={canvas.bridge} />}
      </div>
    </div>
  )
}
