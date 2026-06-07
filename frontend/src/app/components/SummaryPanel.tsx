import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { decorateTitle, normalizeKind } from '../core/idea-descriptors'
import {
  summaryToMarkdown,
  STANDALONE_THEME,
  type BoardCard,
  type ConvergentSummary,
} from '../core/synthesis'

/**
 * The convergence side panel (#28, PD-015) — a **read-only reading** of the
 * board, never an editable surface (PD-011 holds). It renders the structured
 * {@link ConvergentSummary} (themes → decisions → resolutions → open questions →
 * highlights) and offers the markdown artifact via Copy / Download. The summary
 * is generated on demand by `canvas.synthesize` and passed in; this component is
 * pure presentation, so it stays out of the canvas store and the tldraw island.
 */
export function SummaryPanel({
  open,
  onOpenChange,
  summary,
  workspaceName,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  summary: ConvergentSummary | null
  workspaceName?: string
}) {
  const markdown = summary ? summaryToMarkdown(summary) : ''

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
    a.download = `${slug || 'board'}-synthesis.md`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Board synthesis</SheetTitle>
          <SheetDescription>
            {summary && !summary.isEmpty
              ? `${summary.cardCount} ${summary.cardCount === 1 ? 'idea' : 'ideas'}, read into themes and decisions. A generated reading of the board (#28) — edit on the canvas.`
              : 'A generated reading of the board (#28).'}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {!summary || summary.isEmpty ? (
            <p className="text-sm text-muted-foreground">
              No ideas on the board yet — nothing to synthesize.
            </p>
          ) : (
            <div className="flex flex-col gap-5 pb-4">
              {summary.themes.length > 0 && (
                <Section title="Themes">
                  {summary.themes.map((theme, i) => (
                    <div key={i} className="flex flex-col gap-1">
                      <h4 className="text-sm font-semibold">
                        {theme.title === STANDALONE_THEME ? (
                          <span className="text-muted-foreground">{theme.title}</span>
                        ) : (
                          theme.title
                        )}
                      </h4>
                      <CardList cards={theme.cards} />
                    </div>
                  ))}
                </Section>
              )}

              {summary.decisions.length > 0 && (
                <Section title="Decisions">
                  <CardList cards={summary.decisions} />
                </Section>
              )}

              {summary.resolutions.length > 0 && (
                <Section title="Resolved">
                  <ul className="flex flex-col gap-1">
                    {summary.resolutions.map((r, i) => (
                      <li key={i} className="text-sm">
                        <span className="font-medium">{r.winner.title}</span>{' '}
                        <span className="text-muted-foreground">replaces</span>{' '}
                        <span className="text-muted-foreground line-through">
                          {r.replaced.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {summary.openQuestions.length > 0 && (
                <Section title="Open questions">
                  <CardList cards={summary.openQuestions} />
                </Section>
              )}

              {summary.highlights.length > 0 && (
                <Section title="Highlights (marked to keep)">
                  <CardList cards={summary.highlights} />
                </Section>
              )}
            </div>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  )
}

function CardList({ cards }: { cards: BoardCard[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {cards.map((card) => (
        <li key={card.id} className="text-sm leading-snug">
          <span className="font-medium">
            {decorateTitle(card.title, normalizeKind(card.kind))}
          </span>
          {card.body?.trim() ? (
            <span className="text-muted-foreground"> — {card.body.trim()}</span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
