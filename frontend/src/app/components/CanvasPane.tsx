import { useEffect, useState } from 'react'
import * as Toolbar from '@radix-ui/react-toolbar'
import { Scale, ScrollText, FileOutput } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useWorkspaceStore, selectActive } from '../stores/workspace.store'
import { canvas } from '../stores/canvas.store'
import { agent } from '../stores/agent.store'
import { CanvasIsland } from '../core/canvas-island'
import { SummaryPanel } from './SummaryPanel'
import { SpecPanel } from './SpecPanel'
import type { ConvergentSummary } from '../core/synthesis'

/**
 * A canvas-macro toolbar button with an accessible {@link Tooltip} (audit H1 —
 * replaces the old `title=`, which never showed on keyboard focus or touch). The
 * Radix `asChild` chain (TooltipTrigger → Toolbar.Button → Button) keeps it a
 * single real <button> with the toolbar's roving-focus and the tooltip's a11y.
 */
function ToolbarVerb({
  onClick,
  tip,
  variant = 'default',
  children,
}: {
  onClick: () => void
  tip: string
  variant?: 'default' | 'ghost'
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Toolbar.Button asChild>
          <Button size="sm" variant={variant} onClick={onClick}>
            {children}
          </Button>
        </Toolbar.Button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Structural Workspace Canvas (PRD §3.1, §4.1). Hosts the tldraw canvas (the
 * React {@link CanvasIsland}) as the single spatial surface (PD-011). The pane
 * is a shadcn toolbar of agent macros (PRD §3.6) over the canvas, which it
 * renders directly (PD-016). The card filter (#21) lives inside the canvas
 * itself (top-right), not in this toolbar.
 */
export function CanvasPane() {
  const active = useWorkspaceStore(selectActive)
  // Convergence panel (#28): the summary is regenerated each time it opens — a
  // fresh on-demand reading of the current board, never cached stale.
  const [summary, setSummary] = useState<ConvergentSummary | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(false)
  // Spec hand-off (#89): the panel streams the generated artifact; "Hand off"
  // both dispatches the run and opens the panel to read it.
  const [specOpen, setSpecOpen] = useState(false)

  // Bidirectional canvas (#13, #15): when a card verb fires, frame the card's
  // text and type it into the active workspace's live terminal. Registered once;
  // reads the latest active workspace at fire time.
  useEffect(() => {
    canvas.onCardVerb((text, intent, sourceRefs) => {
      const ws = selectActive(useWorkspaceStore.getState())
      if (ws) agent.discussText(ws.id, text, intent, sourceRefs)
    })
  }, [])

  // React to workspace switches — rebind the tldraw island (PRD §3.4). Done at
  // render time (idempotent) so the controller's active id is set BEFORE the
  // freshly-keyed CanvasIsland mounts and `onEditorMount` drains its queue.
  if (active) canvas.switchTo(active.id)

  const triage = () => active && agent.triage(active.id)
  const synthesize = () => {
    if (!active) return
    setSummary(canvas.synthesize(active.id))
    setSummaryOpen(true)
  }
  const handoff = () => {
    if (!active) return
    // Open the panel even if the board is empty — it shows the empty/why state.
    agent.generateSpec(active.id, active.terminal)
    setSpecOpen(true)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="z-[2] flex items-center gap-2 border-b bg-background px-3 py-2">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="!h-5" />
        <div className="flex-1" />
        <Toolbar.Root className="flex gap-2" aria-label="Canvas actions">
          <ToolbarVerb onClick={triage} variant="ghost" tip="Ask the agent to rate every card — impact, effort, confidence (#60)">
            <Scale /> Triage
          </ToolbarVerb>
          <ToolbarVerb onClick={synthesize} variant="ghost" tip="Read the board into a convergent summary (#28)">
            <ScrollText /> Synthesize
          </ToolbarVerb>
          <ToolbarVerb onClick={handoff} tip="Hand off the selection — or the whole board — to the agent as a generated spec/PRD (#89)">
            <FileOutput /> Hand off
          </ToolbarVerb>
        </Toolbar.Root>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-background">
        {active && <CanvasIsland key={active.id} workspaceId={active.id} bridge={canvas.bridge} />}
      </div>

      <SummaryPanel
        open={summaryOpen}
        onOpenChange={setSummaryOpen}
        summary={summary}
        workspaceName={active?.title}
      />

      <SpecPanel
        open={specOpen}
        onOpenChange={setSpecOpen}
        workspaceId={active?.id}
        workspaceName={active?.title}
      />
    </div>
  )
}
