/**
 * Spike (#52): a tldraw canvas rendered as a React island inside the Angular
 * shell. This file is the React half — the Angular wrapper
 * ({@link ../spike/tldraw-spike.component.ts}) mounts it with `createRoot`.
 *
 * It proves the three things the ticket asks for end-to-end:
 *   1. a custom **card shape** (`idea-card`) carrying the idea-graph node fields
 *      (title / body / kind) — the tldraw analogue of an `affine:note`;
 *   2. a **typed edge** between two cards — a native tldraw arrow *bound* to both
 *      cards (so it tracks them on move) whose `relation` (`about` | `supersedes`)
 *      lives in the arrow's `meta` and drives its styling — the analogue of our
 *      `ai-storm:edges` map + `affine:connector`;
 *   3. **persistence** — `persistenceKey` transparently mirrors the whole store to
 *      IndexedDB, so the seeded graph survives a reload (the data-model concern the
 *      ticket flags about coupling persistence to canvas layers).
 *
 * Nothing here is production code; it is a throwaway probe to inform the
 * replace/don't-replace decision in `docs/design/tldraw-spike.md`.
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
} from 'tldraw';
import 'tldraw/tldraw.css';

/** Stable IndexedDB room for the spike (separate from the BlockSuite canvas). */
const PERSISTENCE_KEY = 'ai-storm:tldraw-spike';

/* -------------------------------------------------------------------------- */
/* Custom card shape — the idea-graph node (idea-graph.md §3, kind registry).  */
/* -------------------------------------------------------------------------- */

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
 * Per-kind presentation, the tldraw mirror of the client-only `KIND_REGISTRY`
 * (idea-graph §3.2). One entry per kind = the whole styling story; an unknown
 * kind falls back to a plain white card, exactly as in the BlockSuite impl.
 */
const KIND_TINT: Record<string, string> = {
  idea: '#eef2ff',
  risk: '#fdecec',
  feature: '#eafaf0',
  question: '#fff7e6',
  decision: '#e9f1fb',
};
const KIND_LABEL: Record<string, string> = {
  idea: '💡 Idea',
  risk: '⚠ Risk',
  feature: '✨ Feature',
  question: '❓ Question',
  decision: '✅ Decision',
};

class IdeaCardShapeUtil extends ShapeUtil<IdeaCardShape> {
  static override type = 'idea-card' as const;
  static override props: RecordProps<IdeaCardShape> = {
    w: T.number,
    h: T.number,
    kind: T.string,
    title: T.string,
    body: T.string,
    superseded: T.boolean,
  };

  override getDefaultProps(): IdeaCardShape['props'] {
    return { w: 240, h: 132, kind: 'idea', title: 'Untitled idea', body: '', superseded: false };
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
    const { kind, title, body, superseded } = shape.props;
    const tint = superseded ? '#f2f2f2' : (KIND_TINT[kind] ?? '#ffffff');
    const badge = KIND_LABEL[kind] ?? `#${kind}`;
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
          gap: 6,
          overflow: 'hidden',
          pointerEvents: 'all',
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.7, letterSpacing: '0.02em' }}>
          {badge}
          {superseded ? ' · superseded' : ''}
        </div>
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
/* Seeding — build the idea-graph from the docs once, if the store is empty.   */
/* -------------------------------------------------------------------------- */

/** Edge relation (mirrors shared `IdeaRelation`, idea-graph §2.3). */
type Relation = 'about' | 'supersedes';

/**
 * Draw a native arrow bound to both cards and tag it with its relation. The
 * binding makes tldraw track the endpoints as cards move (the connector
 * behaviour BlockSuite needed a de-risking spike for — here it is built in).
 * `relation` lives in the arrow `meta` (the typed-edge payload) and also styles
 * the arrow: `supersedes` is red + dashed, `about` is a plain grey link.
 */
function connect(editor: Editor, fromId: ReturnType<typeof createShapeId>, toId: ReturnType<typeof createShapeId>, relation: Relation): void {
  const arrowId = createShapeId();
  editor.createShape({
    id: arrowId,
    type: 'arrow',
    // The typed-edge payload: the relation lives in `meta` (the analogue of the
    // `ai-storm:edges` map's `relation`) and also styles the arrow — `supersedes`
    // is red + dashed, `about` is a plain grey link. (tldraw 5 arrow labels are
    // rich-text, omitted here; the relation is carried structurally in meta.)
    meta: { relation },
    props: {
      color: relation === 'supersedes' ? 'red' : 'grey',
      dash: relation === 'supersedes' ? 'dashed' : 'solid',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
    },
  });
  // Bind both terminals to the cards. `createBinding` fills the remaining
  // arrow-binding defaults (snap/edge-hints) from ArrowBindingUtil.getDefaultProps.
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
 * Seed the canonical idea-graph from the design docs (idea-graph §5.1 examples):
 * an idea, a risk *about* it, and a refined feature that *supersedes* the risk —
 * so the supersede ghost treatment (PD-012) and both edge relations are visible.
 * Runs only when the persisted store has no idea cards yet, so a reload restores
 * the user's own graph instead of re-seeding.
 */
function seedGraph(editor: Editor): void {
  // `type` is the known-shape union; 'idea-card' is custom, so compare via string.
  const existing = editor.getCurrentPageShapes().some((s) => (s.type as string) === 'idea-card');
  if (existing) return;

  const a1 = createShapeId();
  const a2 = createShapeId();
  const a3 = createShapeId();

  editor.createShapes([
    {
      id: a1,
      type: 'idea-card',
      x: 160,
      y: 200,
      props: { w: 250, h: 120, kind: 'idea', title: 'Offline-first canvas', body: 'Cache CRDT ops in IndexedDB so the board survives a refresh.', superseded: false },
    },
    {
      id: a2,
      type: 'idea-card',
      x: 560,
      y: 120,
      props: { w: 250, h: 132, kind: 'risk', title: 'Token leak on reconnect', body: 'Refresh races the reattach and double-sends the auth token.', superseded: true },
    },
    {
      id: a3,
      type: 'idea-card',
      x: 560,
      y: 340,
      props: { w: 250, h: 132, kind: 'feature', title: 'Rotate token on attach', body: 'Mint a fresh token per attach; grace-window the old one.', superseded: false },
    },
  ]);

  connect(editor, a2, a1, 'about'); // the risk is ABOUT the idea
  connect(editor, a3, a2, 'supersedes'); // the feature SUPERSEDES the risk (→ a2 ghosted)

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
        onMount={(editor) => seedGraph(editor)}
      />
    </div>
  );
}
