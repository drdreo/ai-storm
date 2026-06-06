/**
 * Spike (#52): a tldraw canvas rendered as a React island inside the Angular
 * shell, rendering **our** idea cards — driven by the shared `Idea` wire type and
 * the real `KIND_REGISTRY` (via `idea-descriptors.ts`), not invented data. The
 * Angular wrapper ({@link ./tldraw-spike.component.ts}) mounts it with `createRoot`.
 *
 * It proves the path the replacement decision (PD-013) hinges on:
 *   1. a custom **card shape** (`idea-card`) carrying the idea-graph node fields
 *      (kind / title / body / origin / lifecycle) — the tldraw analogue of an
 *      `affine:note` — tinted by the SAME kind registry the BlockSuite canvas uses;
 *   2. a **typed edge** — a native tldraw arrow *bound* to two cards (so it tracks
 *      them on move) whose `relation` (`about` | `supersedes`) lives in the arrow's
 *      `meta` and drives its styling — the analogue of `ai-storm:edges` +
 *      `affine:connector`;
 *   3. `applyIdeas(editor, ideas)` — a direct port of `CanvasService.applyIdeas`
 *      (ref resolution → near-target placement → relation edge → supersede ghost →
 *      AI provenance badge), showing the migration is rendering-only;
 *   4. **persistence** via `persistenceKey` → IndexedDB, surviving reload.
 *
 * Throwaway probe for `docs/design/tldraw-spike.md`; not production code.
 */
import {
  Tldraw,
  ShapeUtil,
  Rectangle2d,
  resizeBox,
  HTMLContainer,
  T,
  createShapeId,
  type Editor,
  type Geometry2d,
  type RecordProps,
  type TLBaseShape,
  type TLResizeInfo,
  type TLShapeId,
} from 'tldraw';
import 'tldraw/tldraw.css';
import type { Idea, IdeaRelation } from '@ai-storm/shared';
import { kindLabel, normalizeKind, AI_PROVENANCE_BADGE } from '../core/idea-descriptors';

/** Stable IndexedDB room for the spike (separate from the BlockSuite canvas). */
const PERSISTENCE_KEY = 'ai-storm:tldraw-spike';

/* -------------------------------------------------------------------------- */
/* Custom card shape — the idea-graph node (idea-graph.md §3).                 */
/* -------------------------------------------------------------------------- */

/** Provenance of a card (#31, PD-009): AI-created vs user-drawn. */
type Origin = 'ai' | 'user';

/** A spatial idea card: the tldraw analogue of an `affine:note` (idea-graph §2.1). */
type IdeaCardShape = TLBaseShape<
  'idea-card',
  {
    w: number;
    h: number;
    /** What it IS (idea-graph §2.2) — drives the tint + badge via the registry. */
    kind: string;
    title: string;
    body: string;
    /** Who made it (#31, PD-009) — AI cards get the 🤖 badge + a default tint. */
    origin: Origin;
    /** Lifecycle (#20, PD-012): a supersede target becomes a grey/dashed ghost. */
    superseded: boolean;
  }
>;

/**
 * Register the custom shape with tldraw's type system. tldraw 5 derives the
 * `TLShape` union from the augmentable `TLGlobalShapePropsMap` interface, so this
 * one declaration is what makes `idea-card` a first-class shape type everywhere
 * (`createShape`, `getCurrentPageShapes`, resize helpers) — the typed equivalent
 * of registering a BlockSuite block flavour in the schema.
 */
declare module 'tldraw' {
  interface TLGlobalShapePropsMap {
    'idea-card': IdeaCardShape['props'];
  }
}

/**
 * Per-kind tint — the concrete light-mode values of BlockSuite's
 * `--affine-note-background-*` palette (read from `@toeverything/theme`), so the
 * cards render in tldraw with the EXACT colours `KIND_REGISTRY` (idea-graph §3.2)
 * gives them today. The labels/badges come straight from `kindLabel`, so this map
 * is the only kind-specific thing the spike re-states — and only because tldraw
 * has no BlockSuite CSS vars to resolve.
 */
const KIND_TINT: Record<string, string> = {
  risk: '#fab6b6', // --affine-note-background-red
  feature: '#c9f8c1', // --affine-note-background-green
  question: '#fde68a', // --affine-note-background-yellow
  decision: '#cdebff', // --affine-note-background-blue
  todo: '#c7f8f2', // --affine-note-background-teal
  heuristic: '#ddd6fe', // --affine-note-background-purple
};
/** Default tint for a kindless AI card (mirrors `AI_NOTE_BACKGROUND` = Blue). */
const AI_DEFAULT_TINT = '#cdebff';

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
  };

  override getDefaultProps(): IdeaCardShape['props'] {
    return { w: 250, h: 132, kind: '', title: 'Untitled idea', body: '', origin: 'user', superseded: false };
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
    const { kind, title, body, origin, superseded } = shape.props;
    const normalized = normalizeKind(kind);
    const tint = superseded
      ? '#f2f2f2'
      : (normalized && KIND_TINT[normalized]) ?? (origin === 'ai' ? AI_DEFAULT_TINT : '#ffffff');
    // The badge line mirrors `decorateProvenance(decorateTitle(...))`: a 🤖 for AI
    // cards, then the registry's kind label (or `#tag` for an unknown kind).
    const badge = `${origin === 'ai' ? `${AI_PROVENANCE_BADGE} ` : ''}${normalized ? kindLabel(normalized) : ''}`.trim();
    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          boxSizing: 'border-box',
          padding: '10px 12px',
          borderRadius: 10,
          background: tint,
          border: superseded ? '2px dashed #b6b6b6' : '1px solid rgba(0,0,0,0.14)',
          boxShadow: superseded ? 'none' : '0 1px 4px rgba(0,0,0,0.12)',
          color: superseded ? '#8a8a8a' : '#1c1c1c',
          fontFamily: 'system-ui, sans-serif',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          overflow: 'hidden',
          pointerEvents: 'all',
        }}
      >
        {badge ? (
          <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.72, letterSpacing: '0.02em' }}>
            {badge}
            {superseded ? ' · superseded' : ''}
          </div>
        ) : null}
        <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.25 }}>{title}</div>
        {body ? <div style={{ fontSize: 12, lineHeight: 1.35, opacity: 0.85 }}>{body}</div> : null}
      </HTMLContainer>
    );
  }

  // tldraw 5 takes the selection outline as a Path2D (was a JSX <rect> in v3).
  override getIndicatorPath(shape: IdeaCardShape): Path2D {
    const path = new Path2D();
    path.rect(0, 0, shape.props.w, shape.props.h);
    return path;
  }
}

/* -------------------------------------------------------------------------- */
/* applyIdeas — a direct port of CanvasService.applyIdeas onto tldraw.          */
/* -------------------------------------------------------------------------- */

const CARD_W = 250;
const CARD_H = 132;

/**
 * Draw a native arrow bound to both cards and tag it with its relation. The
 * binding makes tldraw track the endpoints as cards move (the connector
 * behaviour BlockSuite needed a de-risking spike for — here it is built in).
 * `relation` lives in the arrow `meta` (the typed-edge payload) and also styles
 * the arrow: `supersedes` is red + dashed, `about` is a plain grey link.
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
 * port of `CanvasService.applyIdeas`. Each idea becomes an AI-origin `idea-card`;
 * the first link whose target ref already exists places the card near its target
 * and draws a relation-styled arrow; a `supersedes` link ghosts the target
 * (#20, PD-012). Refs (`idea.id`, e.g. `a1`) are resolved within the batch — the
 * same identity layer (idea-graph §4) the BlockSuite impl persists in `ai-storm:ref`.
 */
function applyIdeas(editor: Editor, ideas: Idea[]): void {
  const refToShape = new Map<string, TLShapeId>();
  const childOffset = new Map<TLShapeId, number>();
  const toGhost = new Set<TLShapeId>();
  let gridIndex = 0;

  for (const idea of ideas) {
    // Resolve the first link whose target ref already has a card (graceful
    // degradation: an unresolved link just lands the card on the grid).
    const link = (idea.links ?? []).find((l) => refToShape.has(l.to));
    const targetId = link ? refToShape.get(link.to)! : undefined;

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

    const id = createShapeId();
    editor.createShape<IdeaCardShape>({
      id,
      type: 'idea-card',
      x,
      y,
      props: {
        w: CARD_W,
        h: CARD_H,
        kind: normalizeKind(idea.kind) ?? '',
        title: idea.title,
        body: idea.body,
        origin: 'ai', // applyIdeas is the AI producer (#31, PD-009)
        superseded: false,
      },
    });
    if (idea.id) refToShape.set(idea.id, id);

    if (targetId && link) {
      const relation = link.relation ?? 'about';
      connect(editor, id, targetId, relation);
      if (relation === 'supersedes') toGhost.add(targetId);
    }
  }

  for (const id of toGhost) {
    editor.updateShape<IdeaCardShape>({ id, type: 'idea-card', props: { superseded: true } });
  }
}

/**
 * A realistic brainstorm in OUR wire format (`Idea` with short refs + typed
 * links), mirroring what the `«IDEA…@ref!»` extraction (extraction-contract §3.2)
 * emits — every kind in the registry, an `about` web around one idea, and a
 * `supersedes` (the Challenge verb's output, PD-012) that ghosts its target.
 */
const SEED_IDEAS: Idea[] = [
  { id: 'a1', kind: 'feature', title: 'Offline-first canvas', body: 'Cache CRDT ops in IndexedDB so the board survives a refresh.' },
  { id: 'a2', kind: 'risk', title: 'Token leak on reconnect', body: 'Refresh races the reattach and double-sends the auth token.', links: [{ to: 'a1', relation: 'about' }] },
  { id: 'a3', kind: 'feature', title: 'Rotate token on attach', body: 'Mint a fresh token per attach; grace-window the old one.', links: [{ to: 'a2', relation: 'supersedes' }] },
  { id: 'a4', kind: 'question', title: 'Multi-device sync later?', body: 'Single-user for v0 (PD-001) — but keep the CRDT seam open.', links: [{ to: 'a1', relation: 'about' }] },
  { id: 'a5', kind: 'decision', title: 'Local-first, no server store', body: 'CRDT → IndexedDB is the source of truth (PD-005).', links: [{ to: 'a1', relation: 'about' }] },
  { id: 'a6', kind: 'todo', title: 'Add grace-window timer', body: 'Expire the old token N seconds after a fresh attach.', links: [{ to: 'a3', relation: 'about' }] },
];

/**
 * Seed the brainstorm once (when the persisted store has no idea cards), then add
 * one user-drawn card so the AI/user provenance distinction (#31) is visible.
 */
function seed(editor: Editor): void {
  const has = editor.getCurrentPageShapes().some((s) => (s.type as string) === 'idea-card');
  if (has) return;

  applyIdeas(editor, SEED_IDEAS);

  // A user-origin note (no 🤖 badge, white) — the kind of card the user draws
  // directly in the editor, never touched by applyIdeas (PD-009).
  editor.createShape<IdeaCardShape>({
    id: createShapeId(),
    type: 'idea-card',
    x: 120,
    y: 560,
    props: { w: 250, h: 110, kind: '', title: 'Reuse the CRDT for undo?', body: 'My own note — see if Yjs history gives us undo cheaply.', origin: 'user', superseded: false },
  });

  editor.zoomToFit();
}

/* -------------------------------------------------------------------------- */
/* React entry — the island the Angular wrapper mounts.                        */
/* -------------------------------------------------------------------------- */

export function TldrawCanvas(): React.JSX.Element {
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Tldraw
        persistenceKey={PERSISTENCE_KEY}
        shapeUtils={[IdeaCardShapeUtil]}
        onMount={(editor) => seed(editor)}
      />
    </div>
  );
}
