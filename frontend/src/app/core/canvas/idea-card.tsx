/**
 * The custom `idea-card` shape — the idea-graph node (idea-graph.md §3) and the
 * foundation every other canvas module builds on. Owns the shape type + its
 * `ShapeUtil`, the rendered card body, and the low-level identity/content helpers
 * (`ideaCards`, refs, reading order). Kept "as close to native tldraw as possible":
 * the card tint is a real shared `color` StyleProp, so cards live in the style panel
 * and follow the light/dark theme.
 */
import {
  ShapeUtil,
  Rectangle2d,
  resizeBox,
  HTMLContainer,
  T,
  getColorValue,
  stopEventPropagation,
  useEditor,
  useColorMode,
  DefaultColorStyle,
  type Editor,
  type Geometry2d,
  type RecordProps,
  type TLBaseShape,
  type TLDefaultColorStyle,
  type TLResizeInfo,
  type TLShapeId,
} from 'tldraw';
import { kindLabel, normalizeKind, AI_PROVENANCE_BADGE } from '../idea-descriptors';
import type { CardContent } from '../canvas-text';

/** Provenance of a card (#31, PD-009): AI-created vs user-drawn. */
export type Origin = 'ai' | 'user';

/** A spatial idea card: the tldraw analogue of an `affine:note` (idea-graph §2.1). */
export type IdeaCardShape = TLBaseShape<
  'idea-card',
  {
    w: number;
    h: number;
    /** What it IS (idea-graph §2.2) — drives the badge via the registry. */
    kind: string;
    title: string;
    body: string;
    /** Who made it (#31, PD-009) — AI cards get the 🤖 badge. */
    origin: Origin;
    /** Lifecycle (#20, PD-012): a supersede target becomes a grey/dashed ghost. */
    superseded: boolean;
    /**
     * The card's tint — a **shared** tldraw color StyleProp (was a hardcoded
     * Affine hex). Being `DefaultColorStyle` makes it a first-class member of the
     * style panel: it remembers last-used, persists, and resolves to the active
     * light/dark theme automatically. `kind` sets its default (see `applyIdeas`);
     * the user can recolor freely without changing what the card *is*.
     */
    color: TLDefaultColorStyle;
  }
>;

/**
 * The metadata we hang on a card's `meta` (outside the styled props): its stable
 * SHORT REF (`a1`, `a2`, … — idea-graph §4). A tldraw shape id is a generated
 * token an LLM can't reproduce; the short ref is the identity an agent names in
 * its reply (`«IDEA@a1»`) and an edge points at. Persisted with the shape, so it
 * survives reload. Minted in `applyIdeas` for AI cards and lazily by
 * {@link cardRef} the first time a user card is referenced.
 */
export interface IdeaCardMeta {
  ref?: string;
  /** User mark — "good, keep for later processing" (#29). Toggled via the ★. */
  starred?: boolean;
  /**
   * AI triage score (#60): 1..5 impact / effort (and optional confidence),
   * assigned by the agent via the `«SCORE@ref»` contract. Drives the 2×2
   * prioritization layout (and, later, visual weight). Absent until the board is
   * triaged — `meta` so no schema migration, exactly like `starred`.
   */
  score?: { impact: number; effort: number; confidence?: number };
  [key: string]: unknown;
}

/**
 * Register the custom shape with tldraw's type system. tldraw 5 derives the
 * `TLShape` union from the augmentable `TLGlobalShapePropsMap` interface, so this
 * one declaration makes `idea-card` a first-class shape type everywhere — the
 * typed equivalent of registering a BlockSuite block flavour in the schema.
 */
declare module 'tldraw' {
  interface TLGlobalShapePropsMap {
    'idea-card': IdeaCardShape['props'];
  }
}

export const CARD_W = 250;
export const CARD_H = 132;

export class IdeaCardShapeUtil extends ShapeUtil<IdeaCardShape> {
  static override type = 'idea-card' as const;
  static override props: RecordProps<IdeaCardShape> = {
    w: T.number,
    h: T.number,
    kind: T.string,
    title: T.string,
    body: T.string,
    origin: T.literalEnum('ai', 'user'),
    superseded: T.boolean,
    // A real shared style — this is what wires the card into the style panel and
    // the theme's light/dark color resolution (tldraw styles system).
    color: DefaultColorStyle,
  };

  override getDefaultProps(): IdeaCardShape['props'] {
    return {
      w: CARD_W,
      h: CARD_H,
      kind: '',
      title: 'Untitled idea',
      body: '',
      origin: 'user',
      superseded: false,
      color: 'blue',
    };
  }

  override getGeometry(shape: IdeaCardShape): Geometry2d {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true });
  }

  override canResize = () => true;
  override canEdit = () => true;

  override onResize(shape: IdeaCardShape, info: TLResizeInfo<IdeaCardShape>) {
    return resizeBox(shape, info);
  }

  override component(shape: IdeaCardShape) {
    return <IdeaCardBody shape={shape} />;
  }

  // tldraw 5 takes the selection outline as a Path2D (was a JSX <rect> in v3).
  override getIndicatorPath(shape: IdeaCardShape): Path2D {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}

/**
 * The card's rendered body — a function component (so React hooks are legal)
 * resolving the shape's `color` style against the CURRENT theme. `getColorValue`
 * + `useColorMode` is the styles-system replacement for the old `KIND_TINT`
 * Affine-hex map: the same card reads as a soft `semi` fill in light mode and the
 * theme's dark equivalent in dark mode, with a `solid` accent for the badge. A
 * superseded card (#20, PD-012) recedes to a grey, dashed-border ghost.
 */
function IdeaCardBody({ shape }: { shape: IdeaCardShape }): React.JSX.Element {
  const editor = useEditor();
  const colorMode = useColorMode();
  const { kind, title, body, origin, superseded, color } = shape.props;
  const colors = editor.getCurrentTheme().colors[colorMode];
  const swatch = superseded ? 'grey' : color;
  const tint = getColorValue(colors, swatch, 'semi');
  const accent = getColorValue(colors, swatch, 'solid');
  const text = superseded ? accent : colorMode === 'dark' ? '#e8e8e8' : '#1c1c1c';

  const normalized = normalizeKind(kind);
  // Mirrors `decorateProvenance(decorateTitle(...))`: a 🤖 for AI cards, then the
  // registry's kind label (or `#tag` for an unknown kind).
  const badge = `${origin === 'ai' ? `${AI_PROVENANCE_BADGE} ` : ''}${
    normalized ? kindLabel(normalized) : ''
  }`.trim();

  // User mark (#29): "keep this one for later". Stored in meta (no schema
  // migration), persists with the card, toggled by the ★ in the corner.
  const starred = !!(shape.meta as IdeaCardMeta).starred;
  const score = (shape.meta as IdeaCardMeta).score;
  const toggleStar = (e: React.SyntheticEvent) => {
    stopEventPropagation(e);
    editor.updateShape({
      id: shape.id,
      type: 'idea-card',
      meta: { ...shape.meta, starred: !starred },
    });
  };

  return (
    <HTMLContainer
      style={{
        width: shape.props.w,
        height: shape.props.h,
        boxSizing: 'border-box',
        padding: '10px 12px',
        borderRadius: 10,
        background: tint,
        border: superseded ? `2px dashed ${accent}` : `1px solid ${accent}`,
        boxShadow: superseded ? 'none' : '0 1px 4px rgba(0,0,0,0.12)',
        color: text,
        fontFamily: 'var(--tl-font-sans, system-ui, sans-serif)',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        overflow: 'hidden',
        pointerEvents: 'all',
        opacity: superseded ? 0.85 : 1,
      }}
    >
      <button
        type="button"
        title={starred ? 'Marked — keep for later (click to unmark)' : 'Mark this idea for later'}
        aria-pressed={starred}
        onPointerDown={stopEventPropagation}
        onClick={toggleStar}
        style={{
          position: 'absolute',
          top: 6,
          right: 8,
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          padding: 0,
          lineHeight: 1,
          fontSize: 15,
          color: starred ? '#f5b301' : accent,
          opacity: starred ? 1 : 0.35,
        }}
      >
        {starred ? '★' : '☆'}
      </button>
      {badge ? (
        <div style={{ fontSize: 11, fontWeight: 600, color: accent, letterSpacing: '0.02em' }}>
          {badge}
          {superseded ? ' · superseded' : ''}
        </div>
      ) : null}
      <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25 }}>{title}</div>
      {body ? <div style={{ fontSize: 12, lineHeight: 1.35, opacity: 0.85 }}>{body}</div> : null}
      {score ? (
        // AI triage score (#60): impact / effort / confidence, pinned to the
        // bottom so it reads as a stat strip below the idea.
        <div
          title={`Impact ${score.impact} · Effort ${score.effort}${
            score.confidence != null ? ` · Confidence ${score.confidence}` : ''
          } (AI triage)`}
          style={{
            marginTop: 'auto',
            display: 'flex',
            gap: 10,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.02em',
            color: accent,
            opacity: 0.9,
          }}
        >
          <span>▲ {score.impact}</span>
          <span>⚒ {score.effort}</span>
          {score.confidence != null ? <span>◎ {score.confidence}</span> : null}
        </div>
      ) : null}
    </HTMLContainer>
  );
}

/** Every idea-card shape on the editor's current page. */
export function ideaCards(editor: Editor): IdeaCardShape[] {
  return editor
    .getCurrentPageShapes()
    .filter((s): s is IdeaCardShape => s.type === 'idea-card');
}

/** Highest `a<n>` ref index currently minted on the canvas (0 if none). */
export function maxRefIndex(editor: Editor): number {
  let max = 0;
  for (const card of ideaCards(editor)) {
    const ref = (card.meta as IdeaCardMeta).ref;
    const m = ref ? /^a(\d+)$/.exec(ref) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Read a card's content props for serialization. */
export function content(card: IdeaCardShape): CardContent {
  return { kind: card.props.kind, title: card.props.title, body: card.props.body };
}

/** Cards in stable reading order (top-to-bottom, then left-to-right). */
export function cardsInOrder(editor: Editor): IdeaCardShape[] {
  return ideaCards(editor).sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The stable short ref of a card (idea-graph §4), minting one (`a1`, `a2`, …) on
 * first reference. `applyIdeas` mints refs for AI cards as they are created;
 * this is the lazy path for a user-drawn card the first time an edge names it.
 */
export function cardRef(editor: Editor, shapeId: TLShapeId): string | undefined {
  const shape = editor.getShape(shapeId);
  if (!shape || shape.type !== 'idea-card') return undefined;
  const existing = (shape.meta as IdeaCardMeta).ref;
  if (existing) return existing;
  const ref = `a${maxRefIndex(editor) + 1}`;
  editor.updateShape({ id: shapeId, type: 'idea-card', meta: { ...shape.meta, ref } });
  return ref;
}

/** Resolve a short ref back to its shape id (idea-graph §4), or undefined. */
export function resolveRef(editor: Editor, ref: string): TLShapeId | undefined {
  for (const card of ideaCards(editor)) {
    if ((card.meta as IdeaCardMeta).ref === ref) return card.id;
  }
  return undefined;
}
