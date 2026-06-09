import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { useAgentStore } from '../stores/agent.store'

/**
 * The spec/PRD hand-off panel (#89, PD-015) — the convergence step that closes the
 * brainstorm → structure → hand-off loop (PRD §2). It mirrors the synthesis panel
 * (#28): a **read-only reading** of the board, never an editable surface (PD-011
 * holds). Where synthesis is a pure, instant local read, the spec is *generated* by
 * the downstream agent (PD-007) — so this panel streams the run live (status badge
 * + output) and offers the markdown artifact via Copy / Download once it's there.
 *
 * It subscribes to the workspace's agent run directly, so it re-renders on every
 * stream chunk without re-rendering the canvas. Only `kind: 'spec'` runs surface
 * here; a generic "Send to agent" dispatch streams into the control hub instead.
 */
export function SpecPanel({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId?: string
  workspaceName?: string
}) {
  const run = useAgentStore((s) => (workspaceId ? s.runs[workspaceId] ?? null : null))
  const spec = run?.kind === 'spec' ? run : null
  const markdown = spec?.output ?? ''
  const done = spec?.status === 'exit' || spec?.status === 'error'

  const copy = () => {
    if (markdown) void navigator.clipboard?.writeText(markdown)
  }

  const download = () => {
    if (!markdown) return
    const slug = (workspaceName ?? 'board').trim().replace(/[^\w-]+/g, '-').toLowerCase()
    const blob = new Blob([markdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${slug || 'board'}-spec.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Spec / PRD hand-off
            {spec && (
              <Badge
                variant={
                  spec.status === 'error'
                    ? 'destructive'
                    : spec.status === 'exit'
                      ? 'secondary'
                      : 'default'
                }
                className="uppercase"
              >
                {spec.status}
                {spec.code !== undefined ? ` (${spec.code})` : ''}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            A generated artifact (#89) — the board handed to the agent as a spec to give a coding
            agent. A reading of the board, not an editable surface; refine on the canvas.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {!spec ? (
            <p className="text-sm text-muted-foreground">
              No hand-off yet — click “Hand off” on the canvas to generate a spec from the board.
            </p>
          ) : markdown ? (
            <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-snug">
              {markdown}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              {done ? 'The agent produced no output.' : 'Generating the spec…'}
            </p>
          )}
        </div>

        <div className="flex gap-2 border-t p-4">
          <Button size="sm" variant="outline" onClick={copy} disabled={!markdown}>
            Copy markdown
          </Button>
          <Button size="sm" onClick={download} disabled={!markdown}>
            Download .md
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}
