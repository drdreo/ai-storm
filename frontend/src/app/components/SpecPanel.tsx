import { useEffect, useRef, useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { agent, useAgentStore } from '../stores/agent.store'
import { SPEC_FORMATS, type SpecFormat } from '../core/prompt-framing'
import type { TerminalConfig } from '../core/models'

const LAST_FORMAT_KEY = 'ai-storm:spec-format'

function readLastFormat(): SpecFormat {
  const v = localStorage.getItem(LAST_FORMAT_KEY)
  return v && v in SPEC_FORMATS ? (v as SpecFormat) : 'prd'
}

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
  terminalConfig,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId?: string
  workspaceName?: string
  terminalConfig?: TerminalConfig
}) {
  const run = useAgentStore((s) => (workspaceId ? s.runs[workspaceId] ?? null : null))
  const spec = run?.kind === 'spec' ? run : null
  const markdown = spec?.output ?? ''
  const done = spec?.status === 'exit' || spec?.status === 'error'
  const running = spec?.status === 'spawned' || spec?.status === 'running'

  // Picker state (#110): remembers the last-used format across hand-offs. The
  // "issues create" toggle is per-session (opt-in side effect, not remembered).
  const [format, setFormat] = useState<SpecFormat>(readLastFormat)
  const [createIssues, setCreateIssues] = useState(false)

  const generate = () => {
    if (!workspaceId || !terminalConfig) return
    localStorage.setItem(LAST_FORMAT_KEY, format)
    agent.generateSpec(workspaceId, terminalConfig, format, { createIssues })
  }

  // Transient "it worked" confirmation for the two write actions (#106). Copy and
  // Download both leave the app — one to the OS clipboard, one to a file — with no
  // in-app change to prove they landed. A short-lived `done` flag flips the button
  // to a ✓ + past-tense label, then reverts. One timer, cleared on unmount / re-fire.
  const [flash, setFlash] = useState<'copied' | 'downloaded' | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(flashTimer.current), [])
  const confirm = (which: 'copied' | 'downloaded') => {
    setFlash(which)
    clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(null), 1800)
  }

  const copy = async () => {
    if (!markdown) return
    await navigator.clipboard?.writeText(markdown)
    confirm('copied')
  }

  const download = () => {
    if (!markdown) return
    const slug = (workspaceName ?? 'board').trim().replace(/[^\w-]+/g, '-').toLowerCase()
    const suffix = spec?.format ? SPEC_FORMATS[spec.format].fileSuffix : 'spec'
    const blob = new Blob([markdown], { type: 'text/markdown' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${slug || 'board'}-${suffix}.md`
    a.click()
    URL.revokeObjectURL(url)
    confirm('downloaded')
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Spec hand-off
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
                {spec.format ? SPEC_FORMATS[spec.format].label : ''} · {spec.status}
                {spec.code !== undefined ? ` (${spec.code})` : ''}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            A generated artifact (#89, #110) — the board handed to the agent to produce the picked
            format. A reading of the board, not an editable surface; refine on the canvas.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-2 border-b px-4 pb-3">
          <Tabs value={format} onValueChange={(v) => setFormat(v as SpecFormat)}>
            <TabsList className="w-full">
              {(Object.keys(SPEC_FORMATS) as SpecFormat[]).map((f) => (
                <TabsTrigger key={f} value={f} className="flex-1">
                  {SPEC_FORMATS[f].label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">{SPEC_FORMATS[format].description}</p>

          {format === 'issues' && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={createIssues}
                onChange={(e) => setCreateIssues(e.target.checked)}
                className="size-3.5"
              />
              Actually create the issues via <code>gh</code> (needs <code>gh</code> auth and Bash tool
              permission in the agent args, e.g. <code>--allowedTools "Bash(gh issue create:*)"</code>)
            </label>
          )}

          <Button size="sm" onClick={generate} disabled={!workspaceId || !terminalConfig || running}>
            {running ? 'Generating…' : spec ? 'Regenerate' : 'Generate'}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {!spec ? (
            <p className="text-sm text-muted-foreground">
              Pick a format above and click “Generate” to hand the board off to the agent.
            </p>
          ) : markdown ? (
            <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-snug">
              {markdown}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">
              {done ? 'The agent produced no output.' : 'Generating…'}
            </p>
          )}
        </div>

        <div className="flex gap-2 border-t p-4">
          <Button size="sm" variant="outline" onClick={copy} disabled={!markdown}>
            {flash === 'copied' ? (
              <>
                <Check className="text-emerald-600 dark:text-emerald-500" aria-hidden /> Copied
              </>
            ) : (
              <>
                <Copy aria-hidden /> Copy markdown
              </>
            )}
          </Button>
          <Button size="sm" onClick={download} disabled={!markdown}>
            {flash === 'downloaded' ? (
              <>
                <Check aria-hidden /> Downloaded
              </>
            ) : (
              <>
                <Download aria-hidden /> Download .md
              </>
            )}
          </Button>
          {/* Screen-reader announcement mirroring the visual flash (the icon swap
              alone is silent to AT). */}
          <span role="status" aria-live="polite" className="sr-only">
            {flash === 'copied' ? 'Spec copied to clipboard' : flash === 'downloaded' ? 'Spec downloaded' : ''}
          </span>
        </div>
      </SheetContent>
    </Sheet>
  )
}
