/**
 * Shared canvas testkit: an in-memory {@link EditorFake} standing in for tldraw's
 * `Editor`, plus shape builders. A *fake* (a working implementation), not a mock —
 * it stores shapes/bindings/selection and runs the real module logic against them,
 * so tests exercise actual ref-minting, link resolution, filtering, and triage
 * rather than asserting on stubbed calls. Implements only the slice of `Editor`
 * the canvas core modules touch; cast to the real type via {@link EditorFake.asEditor}.
 *
 * Naming: fakes are `*Fake`, mocks (stubbed call-recorders) are `*Mock`.
 */
import type { Editor } from "tldraw";

/** A minimal tldraw shape record — the fields the canvas core reads/writes. */
export interface ShapeFake {
  id: string;
  type: string;
  x: number;
  y: number;
  rotation: number;
  props: Record<string, unknown>;
  meta: Record<string, unknown>;
  opacity: number;
  isLocked: boolean;
}

/** An arrow binding as `connect()`/`createBinding` records it. */
export interface BindingFake {
  type: string;
  fromId: string;
  toId: string;
  props: { terminal: "start" | "end"; [k: string]: unknown };
}

/** The `idea-card` shape's default props (mirrors the real shape util). */
const IDEA_CARD_DEFAULT_PROPS = {
  w: 250,
  h: 132,
  kind: "",
  title: "",
  body: "",
  origin: "user",
  superseded: false,
  color: "blue"
} as const;

const SHAPE_DEFAULTS = { x: 0, y: 0, rotation: 0, props: {}, meta: {}, opacity: 1, isLocked: false } as const;

/**
 * Build an `idea-card` {@link ShapeFake}. `title` defaults to the id for readable
 * assertions; pass `props`/`meta` overrides to set kind, ref, score, etc.
 */
export function ideaCardShape(id: string, overrides: Partial<ShapeFake> = {}): ShapeFake {
  const { props, meta, ...rest } = overrides;
  return {
    ...SHAPE_DEFAULTS,
    id,
    type: "idea-card",
    props: { ...IDEA_CARD_DEFAULT_PROPS, title: id, ...props },
    meta: { ...meta },
    ...rest
  };
}

/** Build a bare `arrow` {@link ShapeFake}; bind it to cards via {@link EditorFake.addArrow}. */
export function arrowShape(id: string, overrides: Partial<ShapeFake> = {}): ShapeFake {
  const { props, meta, ...rest } = overrides;
  return { ...SHAPE_DEFAULTS, id, type: "arrow", props: { ...props }, meta: { ...meta }, ...rest };
}

/**
 * In-memory stand-in for tldraw's `Editor`. Provides the read/write/selection
 * methods the canvas core calls, plus assertion helpers (`get`, `cards`, `arrows`).
 * `updateShape` mirrors tldraw semantics: top-level fields (x/y/rotation/opacity/
 * isLocked) are set directly while `props`/`meta` merge shallowly.
 */
export class EditorFake {
  readonly shapes = new Map<string, ShapeFake>();
  readonly bindings: BindingFake[] = [];
  private selection = new Set<string>();

  /** Seed a shape onto the board. Returns it for further tweaking. */
  addShape(shape: ShapeFake): ShapeFake {
    this.shapes.set(shape.id, shape);
    return shape;
  }

  /** Seed an arrow bound start→`fromId`, end→`toId`, exactly as `connect()` wires it. */
  addArrow(shape: ShapeFake, fromId: string, toId: string): ShapeFake {
    this.addShape(shape);
    this.bindings.push(
      { type: "arrow", fromId: shape.id, toId: fromId, props: { terminal: "start" } },
      { type: "arrow", fromId: shape.id, toId: toId, props: { terminal: "end" } }
    );
    return shape;
  }

  /** Set the current selection (replacing any prior one). */
  select(...ids: string[]): void {
    this.selection = new Set(ids);
  }

  // --- Editor surface -------------------------------------------------------

  getCurrentPageShapes(): ShapeFake[] {
    return [...this.shapes.values()];
  }

  getCurrentPageId(): string {
    return "page:current";
  }

  getAncestorPageId(id: string): string | undefined {
    return this.shapes.has(id) ? this.getCurrentPageId() : undefined;
  }

  getShape(id: string): ShapeFake | undefined {
    return this.shapes.get(id);
  }

  getSelectedShapes(): ShapeFake[] {
    return [...this.selection].map((id) => this.shapes.get(id)).filter((s): s is ShapeFake => !!s);
  }

  getBindingsFromShape(shape: ShapeFake): BindingFake[] {
    return this.bindings.filter((b) => b.fromId === shape.id);
  }

  createShape(shape: Partial<ShapeFake> & { id: string; type: string }): void {
    this.addShape({ ...SHAPE_DEFAULTS, ...shape, props: { ...shape.props }, meta: { ...shape.meta } });
  }

  createBinding(binding: BindingFake): void {
    this.bindings.push(binding);
  }

  updateShape(update: Partial<ShapeFake> & { id: string }): void {
    const shape = this.shapes.get(update.id);
    if (!shape) return;
    const { id: _id, type: _type, props, meta, ...rest } = update;
    Object.assign(shape, rest);
    if (props) shape.props = { ...shape.props, ...props };
    if (meta) shape.meta = { ...shape.meta, ...meta };
  }

  updateShapes(updates: (Partial<ShapeFake> & { id: string })[]): void {
    for (const u of updates) this.updateShape(u);
  }

  run(fn: () => void): void {
    fn();
  }

  // --- Assertion helpers ----------------------------------------------------

  /** Fetch a shape asserting it exists (for post-condition checks). */
  get(id: string): ShapeFake {
    const shape = this.shapes.get(id);
    if (!shape) throw new Error(`EditorFake: no shape "${id}"`);
    return shape;
  }

  /** Every idea-card on the board. */
  cards(): ShapeFake[] {
    return this.getCurrentPageShapes().filter((s) => s.type === "idea-card");
  }

  /** Every arrow (typed edge) on the board. */
  arrows(): ShapeFake[] {
    return this.getCurrentPageShapes().filter((s) => s.type === "arrow");
  }

  /** Cast to the real `Editor` type — the fake implements the used surface. */
  asEditor(): Editor {
    return this as unknown as Editor;
  }
}
