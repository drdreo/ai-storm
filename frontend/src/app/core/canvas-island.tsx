/**
 * The tldraw canvas — a React island Angular mounts via {@link CanvasService}.
 *
 * This is the real canvas (PD-011: edgeless is the only surface; PD-013: ideas
 * replace, now). It owns the custom `idea-card` shape, the typed-edge graph, the
 * `applyIdeas` port, the card-verb bar (#13/#15) and the kind filter (#21) — the
 * tldraw analogue of everything the BlockSuite `CanvasService` used to do, but
 * "as close to native tldraw as possible": native arrows for edges, the native
 * **styles system** for color (so cards follow the light/dark theme and live in
 * the style panel), and `persistenceKey` → IndexedDB for local-first storage.
 *
 * `CanvasService` (Angular) is the facade; this module holds the `Editor`. The
 * helpers exported here (`applyIdeas`, `serializeEditor`, …) all take the live
 * `Editor` so the service can drive them against whichever workspace is mounted.
 */
import {
  Tldraw,
  ShapeUtil,
  Rectangle2d,
  resizeBox,
  HTMLContainer,
  T,
  createShapeId,
  getColorValue,
  stopEventPropagation,
  track,
  atom,
  type Atom,
  useEditor,
  useColorMode,
  DefaultMainMenu,
  DefaultMainMenuContent,
  DefaultContextMenu,
  DefaultContextMenuContent,
  type TLUiContextMenuProps,
  TldrawUiMenuGroup,
  TldrawUiMenuSubmenu,
  TldrawUiMenuCheckboxItem,
  TldrawUiMenuItem,
  type Editor,
  type Geometry2d,
  type RecordProps,
  type TLBaseShape,
  type TLComponents,
  type TLDefaultColorStyle,
  type TLResizeInfo,
  type TLShapeId,
  DefaultColorStyle,
} from 'tldraw';
import 'tldraw/tldraw.css';
import { useEffect, useMemo, useState } from 'react';
import type { Idea, IdeaRelation, Score } from '@ai-storm/shared';
import {
  kindLabel,
  kindColor,
  normalizeKind,
  isTriageableKind,
  KNOWN_KINDS,
  AI_PROVENANCE_BADGE,
} from './idea-descriptors';
import { cardToText, serializeCards, type CardContent } from './canvas-text';
import {
  layoutMindMap,
  layoutPriorityGrid,
  type LayoutEdge,
  type LayoutRelation,
  type ScoredCard,
} from './idea-layout';
import type { BoardCard, BoardEdge, BoardSnapshot } from './synthesis';
import type { PromptIntent } from './prompt-framing';

/* -------------------------------------------------------------------------- */
/* Custom card shape — the idea-graph node (idea-graph.md §3).                 */
/* -------------------------------------------------------------------------- */

/** Provenance of a card (#31, PD-009): AI-created vs user-drawn. */
type Origin = 'ai' | 'user';

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
     * light/dark theme automatically. `kind` sets its default (see {@link applyIdeas});
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
 * survives reload. Minted in {@link applyIdeas} for AI cards and lazily by
 * {@link cardRef} the first time a user card is referenced.
 */
interface IdeaCardMeta {
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

const CARD_W = 250;
const CARD_H = 132;

class IdeaCardShapeUtil extends ShapeUtil<IdeaCardShape> {
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
function ideaCards(editor: Editor): IdeaCardShape[] {
  return editor
    .getCurrentPageShapes()
    .filter((s): s is IdeaCardShape => s.type === 'idea-card');
}

/** Highest `a<n>` ref index currently minted on the canvas (0 if none). */
function maxRefIndex(editor: Editor): number {
  let max = 0;
  for (const card of ideaCards(editor)) {
    const ref = (card.meta as IdeaCardMeta).ref;
    const m = ref ? /^a(\d+)$/.exec(ref) : null;
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/* -------------------------------------------------------------------------- */
/* applyIdeas — a direct port of CanvasService.applyIdeas onto tldraw.          */
/* -------------------------------------------------------------------------- */

/**
 * Draw a native arrow bound to both cards and tag it with its relation. The
 * binding makes tldraw track the endpoints as cards move (the connector
 * behaviour BlockSuite needed a spike for — here it is built in). `relation`
 * lives in the arrow `meta` (the typed-edge payload) and styles the arrow:
 * `supersedes` is red + dashed, `about` is a plain grey link.
 */
function connect(editor: Editor, fromId: TLShapeId, toId: TLShapeId, relation: IdeaRelation): void {
  const arrowId = createShapeId();
  editor.createShape({
    id: arrowId,
    type: 'arrow',
    meta: { relation },
    props: {
      color: relation === 'supersedes' ? 'red' : 'grey',
      dash: relation === 'supersedes' ? 'dashed' : 'solid',
      // Placeholder endpoints; the bindings below drive the real geometry.
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
    },
  });
  for (const [terminal, target] of [['start', fromId], ['end', toId]] as const) {
    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: target,
      props: { terminal, normalizedAnchor: { x: 0.5, y: 0.5 }, isExact: false, isPrecise: false },
    });
  }
}

/**
 * Render a batch of extracted {@link Idea}s as cards + typed edges — the tldraw
 * port of `CanvasService.applyIdeas`. Each idea becomes an AI-origin `idea-card`
 * colored by its kind (a shared StyleProp); the first link whose target ref
 * already exists places the card near its target and draws a relation-styled
 * arrow; a `supersedes` link ghosts the target (#20, PD-012). Refs (`a1`, `a2`,
 * …) live in `shape.meta.ref` so identity survives reload (idea-graph §4).
 */
export function applyIdeas(editor: Editor, ideas: Idea[]): void {
  if (ideas.length === 0) return;
  const refToShape = new Map<string, TLShapeId>();
  const childOffset = new Map<TLShapeId, number>();
  const toGhost = new Set<TLShapeId>();
  // Seed the ref counter from the persisted shapes (not an in-memory count) so
  // minted refs never collide across sessions (idea-graph §4).
  let nextRef = maxRefIndex(editor) + 1;
  let gridIndex = ideaCards(editor).length;

  editor.run(() => {
    for (const idea of ideas) {
      // Resolve the first link whose target ref already has a card (graceful
      // degradation: an unresolved link just lands the card on the grid).
      const link = (idea.links ?? []).find((l) => refToShape.has(l.to) || !!resolveRef(editor, l.to));
      const targetId = link ? refToShape.get(link.to) ?? resolveRef(editor, link.to) : undefined;

      let x: number;
      let y: number;
      if (targetId) {
        const target = editor.getShape(targetId) as IdeaCardShape | undefined;
        const n = childOffset.get(targetId) ?? 0;
        childOffset.set(targetId, n + 1);
        x = (target?.x ?? 0) + (target?.props.w ?? CARD_W) + 90;
        y = (target?.y ?? 0) + n * 165;
      } else {
        const col = gridIndex % 3;
        const row = Math.floor(gridIndex / 3);
        gridIndex += 1;
        x = 120 + col * 320;
        y = 140 + row * 200;
      }

      const kind = normalizeKind(idea.kind) ?? '';
      const ref = idea.id ?? `a${nextRef++}`;
      const id = createShapeId();
      editor.createShape<IdeaCardShape>({
        id,
        type: 'idea-card',
        x,
        y,
        meta: { ref },
        props: {
          w: CARD_W,
          h: CARD_H,
          kind,
          title: idea.title,
          body: idea.body,
          origin: 'ai', // applyIdeas is the AI producer (#31, PD-009)
          superseded: false,
          // Kind sets the default tint (#21); a kindless AI card defaults to blue.
          color: (kindColor(kind) as TLDefaultColorStyle) ?? 'blue',
        },
      });
      refToShape.set(ref, id);

      if (targetId && link) {
        const relation = link.relation ?? 'about';
        connect(editor, id, targetId, relation);
        if (relation === 'supersedes') toGhost.add(targetId);
      }
    }

    for (const id of toGhost) {
      editor.updateShape<IdeaCardShape>({ id, type: 'idea-card', props: { superseded: true } });
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Graph + serialization helpers (operate on the live Editor).                 */
/* -------------------------------------------------------------------------- */

/** Read a card's content props for serialization. */
function content(card: IdeaCardShape): CardContent {
  return { kind: card.props.kind, title: card.props.title, body: card.props.body };
}

/** Cards in stable reading order (top-to-bottom, then left-to-right). */
function cardsInOrder(editor: Editor): IdeaCardShape[] {
  return ideaCards(editor).sort((a, b) => a.y - b.y || a.x - b.x);
}

/** Serialize every idea card to a normalized markdown document (PRD §3.2). */
export function serializeEditor(editor: Editor): string {
  return serializeCards(cardsInOrder(editor).map(content));
}

/**
 * Flatten the live board into a {@link BoardSnapshot} for synthesis (#28, PD-015)
 * and triage (#60): every idea card in reading order, plus the typed edge graph.
 * Cards are keyed by their tldraw shape id (the same identity `ideaEdges` reports
 * on its endpoints), so the pure `core/` consumers can cluster without knowing
 * anything about tldraw. Reads `starred` off `meta` (#59) and `superseded` off the
 * styled props (#20/PD-012).
 */
export function collectBoard(editor: Editor): BoardSnapshot {
  const cards = cardsInOrder(editor);
  const cardIds = new Set(cards.map((c) => c.id));
  const boardCards: BoardCard[] = cards.map((c) => ({
    id: c.id,
    kind: c.props.kind,
    title: c.props.title,
    body: c.props.body,
    starred: !!(c.meta as IdeaCardMeta).starred,
    superseded: c.props.superseded,
    origin: c.props.origin,
  }));
  const edges: BoardEdge[] = ideaEdges(editor, cardIds).map((e) => ({
    from: e.from as string,
    to: e.to as string,
    relation: e.relation,
  }));
  return { cards: boardCards, edges };
}

/**
 * Plain text of the current selection (PRD §3.6 agent hand-off): the selected
 * idea cards, or the whole canvas when nothing is selected.
 */
export function selectedText(editor: Editor): string {
  const selected = editor
    .getSelectedShapes()
    .filter((s): s is IdeaCardShape => s.type === 'idea-card');
  if (selected.length === 0) return serializeEditor(editor);
  return serializeCards(selected.map(content));
}

/**
 * The board's filterable dimensions (#21+): the full multi-facet model behind the
 * canvas Filter dropdown. A card is visible iff it passes EVERY active facet —
 * kind, provenance, mark, lifecycle, and triage — so the facets compose (AND).
 * Pure data; {@link applyFilter} turns it into per-card opacity.
 */
export interface BoardFilter {
  /** Kinds toggled OFF (#21). Empty ⇒ every kind shown. */
  hiddenKinds: ReadonlySet<string>;
  /** Provenance facet (#31): everything, or only AI / only user cards. */
  origin: 'all' | Origin;
  /** Show only starred cards (#29). */
  markedOnly: boolean;
  /** Show superseded ghosts (#20/PD-012). Off ⇒ they drop out entirely. */
  showSuperseded: boolean;
  /** Show only cards carrying an AI triage score (#60). */
  triagedOnly: boolean;
}

/** The no-op filter — every card visible. The Filter dropdown's reset target. */
export const EMPTY_FILTER: BoardFilter = {
  hiddenKinds: new Set(),
  origin: 'all',
  markedOnly: false,
  showSuperseded: true,
  triagedOnly: false,
};

/**
 * Which facet values actually occur on the current board — drives the dropdown's
 * "always show every option, grey out the ones with no cards" behaviour (#21). A
 * facet with no matching card would silently hide the whole board, so the UI
 * disables it rather than offering a filter that blanks the canvas.
 */
export interface BoardFacets {
  /** Distinct kinds with at least one card. */
  kinds: string[];
  hasAi: boolean;
  hasUser: boolean;
  hasMarked: boolean;
  hasSuperseded: boolean;
  hasTriaged: boolean;
}

/** Scan the board once for {@link BoardFacets} (#21). */
export function boardFacets(editor: Editor): BoardFacets {
  const kinds = new Set<string>();
  let hasAi = false;
  let hasUser = false;
  let hasMarked = false;
  let hasSuperseded = false;
  let hasTriaged = false;
  for (const card of ideaCards(editor)) {
    const k = normalizeKind(card.props.kind);
    if (k) kinds.add(k);
    if (card.props.origin === 'ai') hasAi = true;
    else hasUser = true;
    const meta = card.meta as IdeaCardMeta;
    if (meta.starred) hasMarked = true;
    if (card.props.superseded) hasSuperseded = true;
    if (meta.score) hasTriaged = true;
  }
  return { kinds: [...kinds], hasAi, hasUser, hasMarked, hasSuperseded, hasTriaged };
}

/** Whether a card survives every active facet of `filter`. Pure. */
function cardVisible(card: IdeaCardShape, filter: BoardFilter): boolean {
  const k = normalizeKind(card.props.kind);
  if (k && filter.hiddenKinds.has(k)) return false;
  if (filter.origin !== 'all' && card.props.origin !== filter.origin) return false;
  const meta = card.meta as IdeaCardMeta;
  if (filter.markedOnly && !meta.starred) return false;
  if (!filter.showSuperseded && card.props.superseded) return false;
  if (filter.triagedOnly && !meta.score) return false;
  return true;
}

/**
 * Apply the whole {@link BoardFilter} to the canvas (#21) by toggling each card's
 * opacity (0 ⇒ hidden) and locking hidden cards out of interaction. Native-tldraw
 * replacement for BlockSuite's `displayMode` toggle; cards stay on the board (data
 * is never removed — just dimmed out), so clearing the filter restores them. Recomputes
 * every card from scratch each call, so it's safe to re-run after new cards stream in.
 */
export function applyFilter(editor: Editor, filter: BoardFilter): void {
  const cards = ideaCards(editor);
  if (cards.length === 0) return;
  editor.run(() =>
    editor.updateShapes(
      cards.map((c) => {
        const visible = cardVisible(c, filter);
        return { id: c.id, type: 'idea-card' as const, opacity: visible ? 1 : 0, isLocked: !visible };
      }),
    ),
  );
}

/**
 * The typed graph behind the cards: one {@link LayoutEdge} per bound arrow whose
 * endpoints are both idea cards. `connect()` always binds `start` to the source
 * card and `end` to the target, so the binding terminals recover the edge's
 * direction; the relation rides in the arrow's `meta`. Arrows with a missing or
 * non-card endpoint (mid-drag, or a user's plain arrow) are skipped.
 */
function ideaEdges(editor: Editor, cardIds: ReadonlySet<TLShapeId>): LayoutEdge[] {
  const edges: LayoutEdge[] = [];
  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'arrow') continue;
    let from: TLShapeId | undefined;
    let to: TLShapeId | undefined;
    for (const b of editor.getBindingsFromShape(shape, 'arrow')) {
      const terminal = (b.props as { terminal?: 'start' | 'end' }).terminal;
      if (terminal === 'start') from = b.toId;
      else if (terminal === 'end') to = b.toId;
    }
    if (!from || !to || !cardIds.has(from) || !cardIds.has(to)) continue;
    const relation: LayoutRelation =
      (shape.meta as { relation?: string }).relation === 'supersedes' ? 'supersedes' : 'about';
    edges.push({ from, to, relation });
  }
  return edges;
}

/**
 * Re-flow the idea cards into an organic mind map (#16, PD-014) — the canvas
 * "Arrange" action. Reads the typed edge graph, computes target positions with the
 * pure {@link layoutMindMap} helper, and applies them in one transaction: related
 * cards cluster and fan out from their main idea, superseded originals sit to the
 * left, loose cards tidy into kind-grouped lanes. Only card `x/y` change; edges are
 * native arrows bound to both endpoints, so they track their cards for free — "all
 * relationships preserved" without touching the graph. A no-op on an empty board.
 * Runs on demand only (PD-014): the user's manual placement is never auto-rewritten.
 */
export function arrangeMindMap(editor: Editor): void {
  const cards = ideaCards(editor);
  if (cards.length === 0) return;
  const cardIds = new Set(cards.map((c) => c.id));
  const positions = layoutMindMap(
    cards.map((c) => ({ id: c.id, kind: c.props.kind, x: c.x, y: c.y, w: c.props.w, h: c.props.h })),
    ideaEdges(editor, cardIds),
  );
  editor.run(() => {
    editor.updateShapes(
      positions.map((p) => ({ id: p.id as TLShapeId, type: 'idea-card' as const, x: p.x, y: p.y })),
    );
  });
  // Frame the freshly-tidied board so the new grouping is visible at a glance.
  editor.zoomToFit({ animation: { duration: 200 } });
}

/**
 * Serialize the board for an AI triage pass (#60): one line per card, each LED by
 * its short ref so the agent can address it in a `«SCORE@ref»` reply. Mints a ref
 * for any card lacking one (via {@link cardRef}) so every card is addressable.
 * Deliberately ref-annotated (unlike {@link serializeEditor}, which is kind-badged
 * prose for context) — the ref is the whole point here. Empty board → `''`.
 */
export function serializeForTriage(editor: Editor): string {
  return cardsInOrder(editor)
    // Only rate actionable ideas (#60) — skip risks/questions (commentary).
    .filter((card) => isTriageableKind(card.props.kind))
    .map((card) => {
      const ref = cardRef(editor, card.id);
      const kind = normalizeKind(card.props.kind);
      const tag = kind ? ` [${kind}]` : '';
      const body = card.props.body?.trim();
      const desc = body ? ` — ${body}` : '';
      return `@${ref}${tag} ${card.props.title.trim()}${desc}`;
    })
    .join('\n');
}

/**
 * Apply a triage {@link Score} (#60) to the card it targets: resolve the score's
 * short ref to a shape and stamp `{impact, effort, confidence}` onto its `meta`
 * (the field the 2×2 grid layout reads). A score for an unknown ref is ignored
 * (the card may have been deleted). Stored on `meta`, so no schema migration and
 * it persists with the board — exactly like the keep-mark star (#59).
 */
export function applyScore(editor: Editor, score: Score): void {
  const id = resolveRef(editor, score.ref);
  if (!id) return;
  const shape = editor.getShape(id);
  if (!shape || shape.type !== 'idea-card') return;
  const value: NonNullable<IdeaCardMeta['score']> = { impact: score.impact, effort: score.effort };
  if (typeof score.confidence === 'number') value.confidence = score.confidence;
  editor.updateShape({ id, type: 'idea-card', meta: { ...shape.meta, score: value } });
}

/**
 * Re-flow the board into a 2×2 impact×effort prioritization grid (#60) — the
 * "Grid" action, a sibling of Arrange (#16/PD-014). Reads each card's triage
 * score off `meta.score` (delivered by the `«SCORE@ref»` contract), bins it into
 * a quadrant via the pure {@link layoutPriorityGrid}, and applies the positions in
 * one transaction; unscored cards park in a lane below the grid. Like Arrange,
 * only card `x/y` change — bound edge-arrows track their cards for free — and it
 * runs on demand only. A no-op on an empty board.
 */
export function arrangePriorityGrid(editor: Editor): void {
  const cards = ideaCards(editor);
  if (cards.length === 0) return;
  const scored: ScoredCard[] = cards.map((c) => {
    const score = (c.meta as IdeaCardMeta).score;
    return { id: c.id, w: c.props.w, h: c.props.h, impact: score?.impact, effort: score?.effort };
  });
  const positions = layoutPriorityGrid(scored);
  editor.run(() => {
    editor.updateShapes(
      positions.map((p) => ({ id: p.id as TLShapeId, type: 'idea-card' as const, x: p.x, y: p.y })),
    );
  });
  editor.zoomToFit({ animation: { duration: 200 } });
}

/**
 * Mark/unmark every selected idea card (#29) — the multi-select "★ Mark" action.
 * Toggles as a group: if all selected cards are already marked, this clears them;
 * otherwise it marks them all. No-op when no idea card is selected.
 */
export function markSelected(editor: Editor): void {
  const sel = editor
    .getSelectedShapes()
    .filter((s): s is IdeaCardShape => s.type === 'idea-card');
  if (sel.length === 0) return;
  const allStarred = sel.every((s) => (s.meta as IdeaCardMeta).starred);
  editor.run(() =>
    editor.updateShapes(
      sel.map((s) => ({
        id: s.id,
        type: 'idea-card' as const,
        meta: { ...s.meta, starred: !allStarred },
      })),
    ),
  );
}

/**
 * The stable short ref of a card (idea-graph §4), minting one (`a1`, `a2`, …) on
 * first reference. {@link applyIdeas} mints refs for AI cards as they are created;
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

/* -------------------------------------------------------------------------- */
/* Card verbs (#13/#15) — a selection action bar over a selected idea card.    */
/* -------------------------------------------------------------------------- */

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
const CardVerbBar = track(function CardVerbBar({ onVerb }: { onVerb: CardVerbHandler }) {
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

/* -------------------------------------------------------------------------- */
/* Filter (#21) — a "Filter" submenu in the native main menu (top-left ☰).      */
/* -------------------------------------------------------------------------- */

/**
 * The live board filter (#21), held in a tldraw {@link atom} rather than React
 * state: the main-menu content unmounts every time the menu closes, so the
 * selection has to outlive that. The atom is created per {@link CanvasIsland} mount
 * (see {@link useFilterAtom}) and passed to the two consumers below — so it's
 * naturally per-workspace and resets when you switch boards, with no cross-workspace
 * bookkeeping. {@link FilterApplier} subscribes and applies it; {@link CanvasMainMenu}
 * reads and writes it.
 */
type FilterAtom = Atom<BoardFilter>;

/** A fresh filter atom for the current workspace, discarded when the island remounts. */
function useFilterAtom(): FilterAtom {
  return useState(() => atom<BoardFilter>('boardFilter', EMPTY_FILTER))[0];
}

/** Count of engaged facets — drives the "(N)" hint on the submenu label. */
function filterCount(f: BoardFilter): number {
  return (
    (f.hiddenKinds.size > 0 ? 1 : 0) +
    (f.origin !== 'all' ? 1 : 0) +
    (f.markedOnly ? 1 : 0) +
    (f.triagedOnly ? 1 : 0) +
    (!f.showSuperseded ? 1 : 0)
  );
}

/**
 * Invisible board⇄filter binding (#21): re-applies {@link $filter} as per-card
 * opacity whenever the filter or the set of cards changes. Always mounted (it
 * renders `InFrontOfTheCanvas`, not in the menu), so freshly-streamed cards honour
 * the active filter even while the menu is closed. `track` re-runs it on board
 * changes; `cardsKey` keys the effect off card identity (not opacity), so applying
 * the filter — which only touches opacity/lock — can't loop.
 */
const FilterApplier = track(function FilterApplier({ $filter }: { $filter: FilterAtom }): null {
  const editor = useEditor();
  const filter = $filter.get();
  const cardsKey = ideaCards(editor)
    .map((c) => c.id)
    .join(',');
  useEffect(() => {
    applyFilter(editor, filter);
  }, [editor, filter, cardsKey]);
  return null;
});

/**
 * The native main menu (top-left ☰) with a "Filter" submenu appended (#21) — the
 * idiomatic tldraw way to extend a menu (tldraw.dev/examples/custom-menus): keep
 * {@link DefaultMainMenuContent} and add our own {@link TldrawUiMenuGroup}. `track`
 * makes {@link boardFacets} reactive, so absent facets grey out (disabled) but every
 * option always shows. Toggling writes the filter atom; {@link FilterApplier} applies it.
 */
const CanvasMainMenu = track(function CanvasMainMenu({ $filter }: { $filter: FilterAtom }): React.JSX.Element {
  const editor = useEditor();
  const filter = $filter.get();
  const facets = boardFacets(editor);

  const patch = (p: Partial<BoardFilter>) => {
    $filter.set({ ...filter, ...p });
  };
  const toggleKind = (kind: string) => {
    const hidden = new Set(filter.hiddenKinds);
    if (hidden.has(kind)) hidden.delete(kind);
    else hidden.add(kind);
    $filter.set({ ...filter, hiddenKinds: hidden });
  };

  const count = filterCount(filter);
  const extraKinds = facets.kinds.filter((k) => !(KNOWN_KINDS as readonly string[]).includes(k));
  const displayKinds = [...KNOWN_KINDS, ...extraKinds];

  return (
    <DefaultMainMenu>
      <DefaultMainMenuContent />
      <TldrawUiMenuGroup id="ai-storm">
        <TldrawUiMenuSubmenu id="arrange" label="Arrange" size="small">
          <TldrawUiMenuGroup id="arrange-layouts">
            <TldrawUiMenuItem
              id="arrange-mind-map"
              label="Mind map · by idea"
              readonlyOk
              onSelect={() => arrangeMindMap(editor)}
            />
            <TldrawUiMenuItem
              id="arrange-priority-grid"
              label="Priority grid · by score"
              readonlyOk
              onSelect={() => arrangePriorityGrid(editor)}
            />
          </TldrawUiMenuGroup>
        </TldrawUiMenuSubmenu>
        <TldrawUiMenuSubmenu id="filter" label={count > 0 ? `Filter (${count})` : 'Filter'} size="small">
          <TldrawUiMenuGroup id="filter-kind">
            {displayKinds.map((kind) => (
              <TldrawUiMenuCheckboxItem
                key={kind}
                id={`filter-kind-${kind}`}
                label={kindLabel(kind)}
                checked={!filter.hiddenKinds.has(kind)}
                disabled={!facets.kinds.includes(kind)}
                readonlyOk
                onSelect={() => toggleKind(kind)}
              />
            ))}
          </TldrawUiMenuGroup>
          <TldrawUiMenuGroup id="filter-origin">
            <TldrawUiMenuCheckboxItem
              id="filter-origin-all"
              label="All origins"
              checked={filter.origin === 'all'}
              readonlyOk
              onSelect={() => patch({ origin: 'all' })}
            />
            <TldrawUiMenuCheckboxItem
              id="filter-origin-ai"
              label="🤖 AI only"
              checked={filter.origin === 'ai'}
              disabled={!facets.hasAi}
              readonlyOk
              onSelect={() => patch({ origin: filter.origin === 'ai' ? 'all' : 'ai' })}
            />
            <TldrawUiMenuCheckboxItem
              id="filter-origin-user"
              label="User only"
              checked={filter.origin === 'user'}
              disabled={!facets.hasUser}
              readonlyOk
              onSelect={() => patch({ origin: filter.origin === 'user' ? 'all' : 'user' })}
            />
          </TldrawUiMenuGroup>
          <TldrawUiMenuGroup id="filter-more">
            <TldrawUiMenuCheckboxItem
              id="filter-marked"
              label="★ Marked only"
              checked={filter.markedOnly}
              disabled={!facets.hasMarked}
              readonlyOk
              onSelect={() => patch({ markedOnly: !filter.markedOnly })}
            />
            <TldrawUiMenuCheckboxItem
              id="filter-triaged"
              label="⚖ Triaged only"
              checked={filter.triagedOnly}
              disabled={!facets.hasTriaged}
              readonlyOk
              onSelect={() => patch({ triagedOnly: !filter.triagedOnly })}
            />
            <TldrawUiMenuCheckboxItem
              id="filter-superseded"
              label="Show superseded"
              checked={filter.showSuperseded}
              disabled={!facets.hasSuperseded}
              readonlyOk
              onSelect={() => patch({ showSuperseded: !filter.showSuperseded })}
            />
          </TldrawUiMenuGroup>
          {count > 0 && (
            <TldrawUiMenuGroup id="filter-clear">
              <TldrawUiMenuItem
                id="filter-clear"
                label="Clear filters"
                readonlyOk
                onSelect={() => {
                  $filter.set(EMPTY_FILTER);
                }}
              />
            </TldrawUiMenuGroup>
          )}
        </TldrawUiMenuSubmenu>
      </TldrawUiMenuGroup>
    </DefaultMainMenu>
  );
});

/**
 * The native right-click context menu with the card "Mark" action (#29) prepended
 * — the idiomatic home for a selection action (tldraw.dev/examples/custom-menus):
 * keep {@link DefaultContextMenuContent} and add our own {@link TldrawUiMenuGroup}.
 * `track` makes it reactive to the selection, so the item only appears when an idea
 * card is selected and flips its label between Mark / Unmark to match group state
 * (the same toggle {@link markSelected} performs).
 */
const CanvasContextMenu = track(function CanvasContextMenu(props: TLUiContextMenuProps): React.JSX.Element {
  const editor = useEditor();
  const selectedCards = editor
    .getSelectedShapes()
    .filter((s): s is IdeaCardShape => s.type === 'idea-card');
  const allStarred = selectedCards.length > 0 && selectedCards.every((s) => (s.meta as IdeaCardMeta).starred);
  return (
    <DefaultContextMenu {...props}>
      {selectedCards.length > 0 && (
        <TldrawUiMenuGroup id="ai-storm-card">
          <TldrawUiMenuItem
            id="mark"
            label={allStarred ? 'Unmark' : '★ Mark'}
            onSelect={() => markSelected(editor)}
          />
        </TldrawUiMenuGroup>
      )}
      <DefaultContextMenuContent />
    </DefaultContextMenu>
  );
});

/* -------------------------------------------------------------------------- */
/* React entry — the island the Angular CanvasService mounts.                  */
/* -------------------------------------------------------------------------- */

const SHAPE_UTILS = [IdeaCardShapeUtil];

/** The seam between Angular ({@link CanvasService}) and this React island. */
export interface CanvasBridge {
  /** Called once the editor for the mounted workspace is ready. */
  onEditorMount(editor: Editor): void;
  /** Fired when a card verb (#13/#15) is picked on a selected card. */
  onCardVerb: CardVerbHandler;
}

export function CanvasIsland({
  workspaceId,
  bridge,
}: {
  workspaceId: string;
  bridge: CanvasBridge;
}): React.JSX.Element {
  // One store per workspace, keyed by id → its own IndexedDB room (PD-001,
  // local-first; survives reload). Changing `key`/`persistenceKey` remounts
  // <Tldraw> onto the next workspace's store — the hot-switch of PRD §3.4.
  //
  // The filter atom is created here, so it's scoped to this island: switching
  // workspaces remounts CanvasIsland (it's keyed by id in CanvasPane), which
  // discards this atom and mints a fresh one — each board gets its own filter,
  // reset on switch, with no shared global state to clear (#21).
  const $filter = useFilterAtom();
  const components = useMemo<TLComponents>(
    () => ({
      MainMenu: () => <CanvasMainMenu $filter={$filter} />,
      ContextMenu: CanvasContextMenu,
      InFrontOfTheCanvas: () => (
        <>
          <CardVerbBar onVerb={bridge.onCardVerb} />
          <FilterApplier $filter={$filter} />
        </>
      ),
    }),
    [$filter, bridge],
  );
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Tldraw
        key={workspaceId}
        persistenceKey={`ai-storm:ws:${workspaceId}`}
        shapeUtils={SHAPE_UTILS}
        components={components}
        onMount={(editor) => bridge.onEditorMount(editor)}
      />
    </div>
  );
}
