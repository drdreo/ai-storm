/**
 * The card-verb bar (#13/#15) — the bidirectional-canvas seam. When exactly one
 * idea card is selected, a small action bar floats above it offering the AI verbs;
 * picking one serializes the card and fires the handler (wired to the terminal).
 * Rendered `InFrontOfTheCanvas` by {@link ../canvas-island}.
 */
import { stopEventPropagation, track, useEditor } from 'tldraw';
import { cardToText } from '../canvas-text';
import type { PromptIntent } from '../prompt-framing';
import { cardRef, content, type IdeaCardShape } from './idea-card';

/** A card-level AI verb: a label bound to a {@link PromptIntent} (prompt-framing). */
const CARD_VERBS: ReadonlyArray<{ intent: PromptIntent; label: string }> = [
  { intent: 'discuss', label: 'Discuss' },
  { intent: 'expand', label: 'Expand' },
  { intent: 'challenge', label: 'Challenge' },
  { intent: 'find-risks', label: 'Find risks' },
];

/** The verb fired by the bar: the serialized card text, the intent, and the card ref. */
export type CardVerbHandler = (text: string, intent: PromptIntent, sourceRef?: string) => void;

/**
 * The bidirectional-canvas seam (#13, #15): when exactly one idea card is
 * selected, a small action bar offers the card verbs. Clicking one serializes
 * the card, mints/looks up its source ref, and fires the handler (wired to
 * `AgentService.discussText`, which types a framed prompt into the terminal).
 * Rendered as `InFrontOfTheCanvas`, so it lives natively above the canvas.
 */
export const CardVerbBar = track(function CardVerbBar({ onVerb }: { onVerb: CardVerbHandler }) {
  const editor = useEditor();
  const only = editor.getOnlySelectedShape();
  if (!only || only.type !== 'idea-card') return null;
  const card = only as IdeaCardShape;

  const fire = (intent: PromptIntent) => {
    const text = cardToText(content(card));
    if (!text.trim()) return;
    const sourceRef = cardRef(editor, card.id);
    onVerb(text, intent, sourceRef);
  };

  return (
    <div
      onPointerDown={stopEventPropagation}
      style={{
        position: 'absolute',
        top: 12,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 6,
        padding: 4,
        borderRadius: 8,
        background: 'var(--color-panel, #fff)',
        boxShadow: '0 2px 10px rgba(0,0,0,0.18)',
        pointerEvents: 'all',
        zIndex: 300,
      }}
    >
      {CARD_VERBS.map((verb) => (
        <button
          key={verb.intent}
          type="button"
          onPointerDown={stopEventPropagation}
          onClick={() => fire(verb.intent)}
          style={{
            border: '1px solid var(--color-muted-1, rgba(0,0,0,0.12))',
            borderRadius: 6,
            background: 'var(--color-low, transparent)',
            color: 'var(--color-text, #1c1c1c)',
            padding: '4px 10px',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {verb.label}
        </button>
      ))}
    </div>
  );
});
