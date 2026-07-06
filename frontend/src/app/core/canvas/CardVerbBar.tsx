/**
 * The card-verb bar (#13/#15/#62) — the bidirectional-canvas seam. With exactly
 * one idea card selected, a small action bar floats above it offering the single-
 * card AI verbs; with 2+ selected it offers the multi-select **Combine** verb
 * (#62, PD-019). Picking one serializes the selection and fires the handler
 * (wired to the terminal). Rendered `InFrontOfTheCanvas` by {@link ../canvas-island}.
 */
import { stopEventPropagation, TldrawUiButton, TldrawUiButtonLabel, TldrawUiToolbar, track, useEditor } from "tldraw";
import { cardToText, serializeCards } from "../canvas-text";
import type { PromptIntent } from "../prompt-framing";
import type { IdeaCardShape } from "./idea-card";
import { serializeSelectedIdeas, type SerializedSelectedIdeas } from "./serialize";

/** A card-level AI verb: a label bound to a {@link PromptIntent} (prompt-framing). */
const CARD_VERBS: ReadonlyArray<{ intent: PromptIntent; label: string }> = [
  { intent: "discuss", label: "Discuss" },
  { intent: "expand", label: "Expand" },
  { intent: "challenge", label: "Challenge" },
  { intent: "find-risks", label: "Find risks" }
];

/**
 * The verb fired by the bar: the serialized selection text, the intent, and the
 * source card refs (one for the single-card verbs, several for `combine`).
 */
export type CardVerbHandler = (text: string, intent: PromptIntent, sourceRefs: readonly string[]) => void;

function sourceRefs(payload: SerializedSelectedIdeas): string[] {
  return payload.cards.map((card) => card.ref).filter((ref): ref is string => !!ref);
}

/**
 * The bidirectional-canvas seam (#13, #15, #62): a small action bar over the
 * selected idea card(s). Clicking a verb serializes the selection, mints/looks up
 * each source ref, and fires the handler (wired to `AgentService.discussText`,
 * which types a framed prompt into the terminal). Rendered as `InFrontOfTheCanvas`,
 * so it lives natively above the canvas.
 *
 * One selected card → the single-card verbs. Two or more → the **Combine** verb
 * only (PD-019): a merge is convergent, so the single-card moves (discuss/expand/
 * challenge) don't apply to a multi-card selection.
 */
export const CardVerbBar = track(function CardVerbBar({
  onVerb,
  disabled = false
}: {
  onVerb: CardVerbHandler;
  /** No live session (#106): the verbs type into a terminal that isn't there, so
   *  they render disabled with a "start a session" hint rather than silently no-op. */
  disabled?: boolean;
}) {
  const editor = useEditor();
  const cards = editor.getSelectedShapes().filter((s): s is IdeaCardShape => s.type === "idea-card");
  if (cards.length === 0) return null;
  const multi = cards.length >= 2;
  const disabledTip = "Start a session first — idea actions talk to the live agent";

  // Fire a single-card verb on the lone selected card.
  const fire = (intent: PromptIntent) => {
    const payload = serializeSelectedIdeas(editor);
    const card = payload?.cards[0];
    if (!payload || !card) return;
    const text = cardToText(card);
    if (!text.trim()) return;
    onVerb(text, intent, sourceRefs(payload));
  };

  // Fire the multi-select combine verb: serialize every selected card and mint a
  // ref for each so the merged idea can supersede them all (#62).
  const fireCombine = () => {
    const payload = serializeSelectedIdeas(editor);
    if (!payload) return;
    const text = serializeCards(payload.cards);
    if (!text.trim()) return;
    onVerb(text, "combine", sourceRefs(payload));
  };

  return (
    <div
      onPointerDown={stopEventPropagation}
      style={{
        position: "absolute",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        display: "flex",
        padding: 4,
        borderRadius: "var(--tl-radius-3, 8px)",
        background: "var(--tl-color-panel, #fff)",
        boxShadow: "var(--tl-shadow-2, 0 2px 10px rgba(0,0,0,0.18))",
        pointerEvents: "all",
        zIndex: 300
      }}
    >
      {/* Native tldraw toolbar + buttons: hover/focus states, keyboard nav, and
          tooltips come from tldraw's own UI layer (its CSS is already loaded). */}
      <TldrawUiToolbar label="Card actions">
        {multi ? (
          <TldrawUiButton
            type="normal"
            disabled={disabled}
            onClick={fireCombine}
            tooltip={disabled ? disabledTip : `Merge the ${cards.length} selected cards into one stronger idea`}
          >
            <TldrawUiButtonLabel>✦ Combine into one</TldrawUiButtonLabel>
          </TldrawUiButton>
        ) : (
          CARD_VERBS.map((verb) => (
            <TldrawUiButton
              key={verb.intent}
              type="normal"
              disabled={disabled}
              tooltip={disabled ? disabledTip : undefined}
              onClick={() => fire(verb.intent)}
            >
              <TldrawUiButtonLabel>{verb.label}</TldrawUiButtonLabel>
            </TldrawUiButton>
          ))
        )}
      </TldrawUiToolbar>
    </div>
  );
});
