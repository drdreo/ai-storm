/**
 * First-run teaching overlay (#77 audit H2). A blank infinite canvas teaches a
 * newcomer nothing, so while the board holds zero idea cards we float a centered
 * hint that names the three core moves. It's a `track`ed tldraw component
 * (rendered `InFrontOfTheCanvas` by {@link ../canvas-island}) so it reacts to the
 * store: the moment the first card lands — whether the user presses `i` or the
 * agent streams ideas in — `ideaCards(editor)` is non-empty and this unmounts.
 *
 * The teaching signage is `pointer-events: none` (it must not intercept a
 * pan/zoom/draw on the empty canvas beneath it), but the primary-action buttons
 * below re-enable pointer events on themselves so a newcomer can take the first
 * move — drop a card, start a session, open settings — without hunting for the
 * chrome (#106).
 */
import { track, useEditor } from "tldraw";
import { Plus, Play, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ideaCards } from "./idea-card";

/** One taught move: a leading glyph/key and its explanation. */
const MOVES: ReadonlyArray<{ key: string; label: string }> = [
  { key: "i", label: "Press to drop your first idea card" },
  { key: "▸", label: "Start a session — the agent’s ideas land here as cards" },
  { key: "✦", label: "Select a card to Discuss, Expand, Challenge, or Combine" }
];

/** The empty-state's primary actions, wired to app handlers (#106). */
export interface EmptyStateActions {
  onNewIdea(): void;
  onStartSession(): void;
  onOpenSettings(): void;
  /** Session already live ⇒ hide "Start session" (the agent path is open). */
  attached: boolean;
}

export const CanvasEmptyState = track(function CanvasEmptyState({ actions }: { actions?: EmptyStateActions }) {
  const editor = useEditor();
  if (ideaCards(editor).length > 0) return null;

  return (
    <div
      style={{ pointerEvents: "none" }}
      className="absolute inset-0 z-[1] flex flex-col items-center justify-center gap-5 px-6 text-center"
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold text-foreground">Start your storm</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          An open canvas for you and the agent to think together. Ideas become cards you can arrange, mark, and refine.
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
      {actions && (
        <div className="flex flex-wrap items-center justify-center gap-2" style={{ pointerEvents: "auto" }}>
          <Button size="sm" onClick={actions.onNewIdea}>
            <Plus aria-hidden /> New idea
          </Button>
          {!actions.attached && (
            <Button size="sm" variant="outline" onClick={actions.onStartSession}>
              <Play aria-hidden /> Start session
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={actions.onOpenSettings}>
            <Settings aria-hidden /> Open settings
          </Button>
        </div>
      )}
    </div>
  );
});
