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
  useEditor,
  useColorMode,
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
import { ideaIdentityKey, type Idea, type IdeaRelation } from '@ai-storm/shared';
import {
  kindLabel,
  kindColor,
  normalizeKind,
  AI_PROVENANCE_BADGE,
} from './idea-descriptors';
import { cardToText, serializeCards, type CardContent } from './canvas-text';
import { layoutMindMap, type LayoutEdge, type LayoutRelation } from './idea-layout';
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
  /** Canonical, reflow-stable identity of the idea this card was minted from
   *  (the shared `ideaIdentityKey`). Lets {@link applyIdeas} resolve a
   *  re-extracted idea to THIS card instead of duplicating it when a terminal
   *  resize re-wraps the source text (#38). */
  identity?: string;
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
  // Idempotency (#38): never mint a second card for an idea we already have. The
  // backend reads ideas off a *reflowing* terminal and can re-emit the same idea
  // after a pane resize (its rejoined body text drifts); keying on the canonical,
  // reflow-stable identity — the SAME `ideaIdentityKey` the backend dedupes on —
  // resolves a repeat to the existing card instead of duplicating it.
  const seen = new Set<string>();
  for (const card of ideaCards(editor)) {
    const key = (card.meta as IdeaCardMeta).identity;
    if (key) seen.add(key);
  }

  editor.run(() => {
    for (const idea of ideas) {
      const identity = ideaIdentityKey(idea);
      if (seen.has(identity)) continue; // already on the canvas — skip the duplicate
      seen.add(identity);

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
        meta: { ref, identity },
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

/** Distinct kinds with at least one card on the canvas (#21). */
export function kindsPresent(editor: Editor): string[] {
  const kinds = new Set<string>();
  for (const card of ideaCards(editor)) {
    const k = normalizeKind(card.props.kind);
    if (k) kinds.add(k);
  }
  return [...kinds];
}

/**
 * Show or hide every card of a given `kind` (#21) by toggling its opacity (0 ⇒
 * hidden) and locking hidden cards out of interaction. Native-tldraw replacement
 * for BlockSuite's `displayMode` toggle; the card stays on the board (data is
 * never removed — just dimmed out).
 */
export function setKindVisible(editor: Editor, kind: string, visible: boolean): void {
  const target = normalizeKind(kind);
  if (!target) return;
  const ids = ideaCards(editor)
    .filter((c) => normalizeKind(c.props.kind) === target)
    .map((c) => c.id);
  if (ids.length === 0) return;
  editor.run(() =>
    editor.updateShapes(
      ids.map((id) => ({ id, type: 'idea-card' as const, opacity: visible ? 1 : 0, isLocked: !visible })),
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
 * Select every marked idea card (#29) so the user can act on them as a batch
 * (Send to agent / Inject context). Returns how many were selected.
 */
export function selectMarked(editor: Editor): number {
  const ids = ideaCards(editor)
    .filter((c) => (c.meta as IdeaCardMeta).starred)
    .map((c) => c.id);
  editor.select(...ids);
  return ids.length;
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
  const components: TLComponents = {
    InFrontOfTheCanvas: () => <CardVerbBar onVerb={bridge.onCardVerb} />,
  };
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
