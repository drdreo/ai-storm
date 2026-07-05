import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn, formatSpan } from "@/lib/utils";
import type { BoardStats, KindCount } from "../core/board-stats";
import type { BoardFilter } from "../core/canvas/filter";
import { kindLabel } from "../core/idea-descriptors";

/**
 * The board-stats side panel (#129, and the convergence signals of #99) — a
 * read-only *reading* of the board into headline counts, a kind breakdown, and a
 * generation timeline. Never an editable surface (PD-011 holds): every number is
 * derived on demand from the live canvas by `canvas.boardStats` and passed in, so
 * this component is pure presentation, like {@link SummaryPanel}.
 *
 * Metrics that map onto a real {@link BoardFilter} facet are clickable — clicking
 * one filters the canvas to those cards (the navigation-aid intent of #99, "click
 * a metric to select/filter"). Metrics with no matching facet (unlinked,
 * untriaged, superseded) are shown as plain readouts.
 */
export function StatsPanel({
  open,
  onOpenChange,
  stats,
  onApplyFilter,
  onClearFilters
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stats: BoardStats | null;
  /** Apply a filter facet patch to the canvas, then close so the result is visible. */
  onApplyFilter: (patch: Partial<BoardFilter>) => void;
  /** Reset every facet — the "Show all" affordance. */
  onClearFilters: () => void;
}) {
  const empty = !stats || stats.isEmpty;

  // Isolate one kind: hide every OTHER kinded card. Kindless cards can't be
  // targeted by `hiddenKinds` (the filter keys on a kind), so they stay visible —
  // an accepted limitation of the facet model, not a bug here.
  const isolateKind = (kind: string) => {
    if (!stats) return;
    const others = stats.kinds.map((k) => k.kind).filter((k) => k && k !== kind);
    apply({ hiddenKinds: new Set(others) });
  };

  const apply = (patch: Partial<BoardFilter>) => {
    onApplyFilter(patch);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Board stats</SheetTitle>
          <SheetDescription>
            {empty
              ? "A live readout of this board (#129)."
              : `${stats.total} ${stats.total === 1 ? "idea" : "ideas"} on the board. Click a metric to filter the canvas.`}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          {empty ? (
            <p className="text-sm text-muted-foreground">No ideas on the board yet — nothing to measure.</p>
          ) : (
            <div className="flex flex-col gap-6 pb-4">
              {/* Provenance — AI vs user (#31). Both are real origin facets. */}
              <Section title="Provenance">
                <div className="grid grid-cols-3 gap-2">
                  <Tile label="Total" value={stats.total} onClick={onClearFilters} hint="Show all cards" />
                  <Tile
                    label="AI"
                    value={stats.aiCount}
                    onClick={stats.aiCount ? () => apply({ origin: "ai" }) : undefined}
                  />
                  <Tile
                    label="User"
                    value={stats.userCount}
                    onClick={stats.userCount ? () => apply({ origin: "user" }) : undefined}
                  />
                </div>
              </Section>

              {/* Kind breakdown (#21/#129) — each row isolates its kind. */}
              <Section title="Kinds">
                {stats.kinds.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No kinded cards.</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    {stats.kinds.map((k) => (
                      <KindRow
                        key={k.kind || "__kindless"}
                        entry={k}
                        max={stats.total}
                        onClick={k.kind ? () => isolateKind(k.kind) : undefined}
                      />
                    ))}
                  </div>
                )}
              </Section>

              {/* Convergence signals (#99). Marked/triaged map to facets and are
                  clickable; the rest are plain readouts (no matching facet). */}
              <Section title="Convergence signals">
                <div className="grid grid-cols-2 gap-2">
                  <Tile
                    label="Marked"
                    value={stats.markedCount}
                    onClick={stats.markedCount ? () => apply({ markedOnly: true }) : undefined}
                    hint="Cards you starred to keep"
                  />
                  <Tile
                    label="Triaged"
                    value={stats.triagedCount}
                    onClick={stats.triagedCount ? () => apply({ triagedOnly: true }) : undefined}
                    hint="Cards the agent scored"
                  />
                  <Tile label="Untriaged" value={stats.untriagedCount} hint="Actionable cards not yet scored" />
                  <Tile
                    label="Open questions"
                    value={stats.openQuestions}
                    onClick={stats.openQuestions ? () => isolateKind("question") : undefined}
                  />
                  <Tile
                    label="Decisions"
                    value={stats.decisions}
                    onClick={stats.decisions ? () => isolateKind("decision") : undefined}
                  />
                  <Tile label="Unlinked" value={stats.unlinkedCount} hint="Cards with no connections" />
                  <Tile label="Superseded" value={stats.supersededCount} hint="Replaced by a refined card" />
                </div>
              </Section>

              {/* Generation timeline (#129) — a histogram of when ideas landed,
                  built from the cards that carry a createdAt (#124). */}
              <Section title="Idea timeline">
                <Timeline stats={stats} />
              </Section>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * A single metric tile. Clickable when `onClick` is given (it maps to a filter),
 * otherwise a static readout — the two look distinct so a user knows which
 * numbers act as navigation. A zero count is always static (nothing to filter to).
 */
function Tile({ label, value, onClick, hint }: { label: string; value: number; onClick?: () => void; hint?: string }) {
  const interactive = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!interactive}
      title={hint}
      className={cn(
        "flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors",
        interactive ? "cursor-pointer hover:bg-accent hover:text-accent-foreground" : "cursor-default"
      )}
    >
      <span className="text-lg font-semibold tabular-nums leading-none">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </button>
  );
}

/** One kind's row: badge label, a proportional bar, and its count. */
function KindRow({ entry, max, onClick }: { entry: KindCount; max: number; onClick?: () => void }) {
  const label = entry.kind ? kindLabel(entry.kind) : "Untyped";
  const pct = max > 0 ? Math.round((entry.count / max) * 100) : 0;
  const interactive = !!onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!interactive}
      title={interactive ? `Show only ${label} cards` : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
        interactive ? "cursor-pointer hover:bg-accent hover:text-accent-foreground" : "cursor-default"
      )}
    >
      <span className="w-28 shrink-0 truncate text-sm">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </span>
      <span className="w-6 shrink-0 text-right text-sm tabular-nums text-muted-foreground">{entry.count}</span>
    </button>
  );
}

/**
 * The idea-generation histogram (#129). Renders `stats.timeline` as equal-width
 * bars; when too few cards carry a `createdAt` to plot (older cards predate the
 * timestamp, #124), it explains that instead of showing an empty chart.
 */
function Timeline({ stats }: { stats: BoardStats }) {
  if (stats.timeline.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {stats.datedCount < 2
          ? "Not enough dated ideas to chart yet."
          : "All ideas landed at the same moment — nothing to spread over time."}
      </p>
    );
  }
  const peak = Math.max(...stats.timeline.map((b) => b.count), 1);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex h-20 items-end gap-0.5" aria-hidden="true">
        {stats.timeline.map((b, i) => (
          <span
            key={i}
            className="flex-1 rounded-sm bg-primary/70"
            style={{ height: `${Math.max(3, Math.round((b.count / peak) * 100))}%` }}
            title={`${b.count} ${b.count === 1 ? "idea" : "ideas"}`}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {stats.datedCount} of {stats.total} ideas dated, over {formatSpan(stats.timelineSpanMs)}.
      </p>
    </div>
  );
}
