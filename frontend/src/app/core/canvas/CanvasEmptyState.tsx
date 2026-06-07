/**
 * First-run teaching overlay (#77 audit H2). A blank infinite canvas teaches a
 * newcomer nothing, so while the board holds zero idea cards we float a centered
 * hint that names the three core moves. It's a `track`ed tldraw component
 * (rendered `InFrontOfTheCanvas` by {@link ../canvas-island}) so it reacts to the
 * store: the moment the first card lands — whether the user presses `i` or the
 * agent streams ideas in — `ideaCards(editor)` is non-empty and this unmounts.
 *
 * Deliberately `pointer-events: none` end-to-end: it's signage, never a control,
 * so it can't intercept a pan/zoom/draw on the empty canvas beneath it.
 */
import { track, useEditor } from 'tldraw';
import { ideaCards } from './idea-card';

/** One taught move: a leading glyph/key and its explanation. */
const MOVES: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'i', label: 'Press to drop your first idea card' },
  { key: '▸', label: 'Start a session — the agent’s ideas land here as cards' },
  { key: '✦', label: 'Select a card to Discuss, Expand, Challenge, or Combine' },
];

export const CanvasEmptyState = track(function CanvasEmptyState() {
  const editor = useEditor();
  if (ideaCards(editor).length > 0) return null;

  return (
    <div
      style={{ pointerEvents: 'none' }}
      className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-5 px-6 text-center"
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold text-foreground">Start your storm</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          An open canvas for you and the agent to think together. Ideas become cards
          you can arrange, mark, and refine.
        </p>
      </div>
      <ul className="flex flex-col gap-2.5 text-left">
        {MOVES.map((m) => (
          <li key={m.key} className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border bg-muted px-1.5 text-xs font-medium text-foreground">
              {m.key}
            </kbd>
            <span>{m.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});
