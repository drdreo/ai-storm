/**
 * The always-visible active-state bar near the canvas toolbar (#108). The board's
 * filter and arrangement used to live only inside the ☰ menu (the `Filter (N)`
 * label and the Arrange checkmarks), so a user couldn't see *what* was narrowing
 * or reshaping the board without opening it. This floats a compact, removable chip
 * per engaged facet — one per {@link filterChips} entry, plus an arrangement chip
 * when a grid / mind-map layout is active — with a one-click "Clear all".
 *
 * A `track`ed tldraw component (rendered `InFrontOfTheCanvas` by
 * {@link ../canvas-island}) so it reacts to both the per-island filter atom and the
 * per-editor {@link activeBoardLayout} signal: removing a chip writes straight back
 * through the chip's `remove` reducer / the layout atom, exactly what the menu items
 * do. The bar is `pointer-events: none` so it never eats a pan/zoom in the gaps;
 * only the chips and buttons re-enable pointer events on themselves.
 */
import { track, useEditor, type Atom } from "tldraw";
import { X } from "lucide-react";
import { filterChips } from "./filter-chips";
import { EMPTY_FILTER, type BoardFilter } from "./filter";
import { activeBoardLayout, restoreFreeLayout, type ActiveBoardLayout } from "./layout";

/** A project's live filter atom, shared from {@link ../menus}. */
type FilterAtom = Atom<BoardFilter>;

/** Short label for the active arrangement chip (#100/#108). */
function layoutLabel(layout: ActiveBoardLayout): string {
  return layout.mode === "grid" ? "▦ Priority grid" : "✦ Mind map";
}

export const FilterChips = track(function FilterChips({ $filter }: { $filter: FilterAtom }): React.JSX.Element | null {
  const editor = useEditor();
  const filter = $filter.get();
  const chips = filterChips(filter);
  const $layout = activeBoardLayout(editor);
  const layout = $layout.get();

  const total = chips.length + (layout ? 1 : 0);
  if (total === 0) return null;

  const clearAll = () => {
    $filter.set(EMPTY_FILTER);
    // Drop the arrangement AND put the cards back where the user had them (#169).
    restoreFreeLayout(editor);
  };

  return (
    <div
      style={{ pointerEvents: "none" }}
      className="absolute left-1/2 top-2 z-[1] flex max-w-[min(90%,44rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5"
    >
      {layout && (
        <Chip
          label={layoutLabel(layout)}
          title="Remove arrangement · restore layout"
          onRemove={() => restoreFreeLayout(editor)}
        />
      )}
      {chips.map((chip) => (
        <Chip
          key={chip.id}
          data-testid={`filter-chip-${chip.id}`}
          label={chip.label}
          title={`Remove filter: ${chip.label}`}
          onRemove={() => $filter.set(chip.remove(filter))}
        />
      ))}
      {/* A one-click reset (#108). Redundant with a lone chip's ✕, so only offered
          once two or more facets stack up. */}
      {total >= 2 && (
        <button
          type="button"
          onClick={clearAll}
          style={{ pointerEvents: "auto" }}
          className="inline-flex h-6 items-center rounded-full border border-border bg-background/90 px-2.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-muted hover:text-foreground"
        >
          Clear all
        </button>
      )}
    </div>
  );
});

/** One removable pill: its label and an ✕ that clears the facet it names. */
function Chip({
  label,
  title,
  onRemove,
  ...rest
}: {
  label: string;
  title: string;
  onRemove(): void;
} & React.HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <span
      {...rest}
      style={{ pointerEvents: "auto" }}
      className="inline-flex h-6 items-center gap-1 rounded-full border border-border bg-background/90 pl-2.5 pr-1 text-xs font-medium text-foreground shadow-sm backdrop-blur"
    >
      {label}
      <button
        type="button"
        onClick={onRemove}
        title={title}
        aria-label={title}
        className="inline-flex size-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  );
}
