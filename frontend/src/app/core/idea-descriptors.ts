/**
 * Pure idea → block adapter (extraction-contract §8.2) + the kind registry.
 *
 * Kept deliberately free of any BlockSuite / DOM import so it is unit-testable
 * in isolation (like `markdown-block-parser.ts`). `CanvasService` consumes it to
 * render extracted ideas as cards/notes; `IngestionService` consumes it to feed
 * the render scheduler.
 */

import type { CreateIdeaInput } from "@ai-storm/shared";
import { MarkdownBlockParser, type BlockDescriptor } from "./markdown-block-parser";

/**
 * One kind's behaviour, in one place (idea-graph design §3.2). The registry is
 * the single client-side home for everything a `kind` drives — it absorbs and
 * replaces the three parallel maps (label / background / known-set) that used to
 * be maintained separately and could drift. Adding an ideation concept is now
 * ONE registry entry: no wire change, no parser branch. Presentation-only — it
 * never touches the wire contract.
 */
export interface KindSpec {
  /** Card-heading badge, e.g. '⚠ Risk' (unknown kinds fall back to a `#tag`). */
  label: string;
  /**
   * Card tint — a tldraw palette **color-style name** (`'red' | 'green' | …`, a
   * `TLDefaultColorStyle` value), kept as a plain string so this module stays
   * tldraw-import-free (Node-testable). The canvas sets it as the card shape's
   * shared `color` StyleProp, so a kind's cards adopt the theme's light/dark
   * resolution of that palette entry and participate in the native style panel
   * (tldraw styles system). `kind` stays the semantic source of truth; the color
   * is just its default presentation.
   */
  color: string;
  /** Per-kind card shape (#40). 'note' for every kind today; reserved. */
  shape?: "note" | "diamond";
}

/**
 * Ordered set of the known kinds (#21) — the one place a kind is declared. Drives
 * the literal {@link IdeaKind} union, {@link KNOWN_KINDS} ordering, and the
 * registry's key completeness (a missing entry is a compile error).
 */
const KIND_ORDER = ["risk", "feature", "question", "decision", "todo", "heuristic"] as const;

/** The kinds AI-Storm recognises (#21). */
export type IdeaKind = (typeof KIND_ORDER)[number];

/** The single source of truth for per-kind behaviour (idea-graph design §3.2). */
export const KIND_REGISTRY: Record<IdeaKind, KindSpec> = {
  risk: { label: "⚠ Risk", color: "red" },
  feature: { label: "✨ Feature", color: "green" },
  question: { label: "❓ Question", color: "yellow" },
  decision: { label: "✅ Decision", color: "blue" },
  todo: { label: "☑ Todo", color: "light-blue" },
  heuristic: { label: "💡 Idea", color: "violet" }
};

/** Ordered list of the known {@link IdeaKind}s (#21), e.g. for chip ordering. */
export const KNOWN_KINDS: readonly IdeaKind[] = KIND_ORDER;

/**
 * Canonicalise an idea's `kind` for use as a registry/map key (#21): trim and
 * lowercase it, returning `undefined` for a missing or blank value. Pure.
 */
export function normalizeKind(kind?: string): string | undefined {
  const trimmed = kind?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

/** The {@link KindSpec} for a kind (normalising first), or undefined if unknown. */
export function kindSpec(kind?: string): KindSpec | undefined {
  const normalized = normalizeKind(kind);
  return normalized ? KIND_REGISTRY[normalized as IdeaKind] : undefined;
}

/**
 * Presentation label for a kind's card heading / filter chip (#21): the registry
 * badge for a known kind, else a plain `#tag` for an unknown one.
 */
export function kindLabel(kind: string): string {
  return kindSpec(kind)?.label ?? `#${kind}`;
}

/**
 * Resolve a kind's tldraw palette color-style name (#21), e.g. `risk` → `'red'`.
 * Returns `undefined` for an unknown, missing, or blank kind so the canvas can
 * fall back to its default color. Pure — no tldraw dependency.
 */
export function kindColor(kind?: string): string | undefined {
  return kindSpec(kind)?.color;
}

/**
 * Kinds excluded from AI triage (#60): a `risk` or `question` is *commentary on*
 * an idea, not a candidate to prioritize — scoring them pollutes the impact×effort
 * grid (a high-impact risk reads like a high-value idea). Triage therefore rates
 * only the actionable cards (features, decisions, todos, and kindless root ideas).
 */
export const TRIAGE_SKIP_KINDS: ReadonlySet<string> = new Set(["risk", "question"]);

/**
 * Whether a card of this kind should be rated by AI triage (#60). True for an
 * actionable idea (feature / decision / todo / heuristic / kindless); false for
 * the commentary kinds in {@link TRIAGE_SKIP_KINDS}.
 */
export function isTriageableKind(kind?: string): boolean {
  return !TRIAGE_SKIP_KINDS.has(normalizeKind(kind) ?? "");
}

/** Prefix a card heading with its kind badge (or `#tag`); bare title if no kind. */
export function decorateTitle(title: string, kind?: string): string {
  if (!kind) return title;
  return `${kindLabel(kind)}: ${title}`;
}

/** Provenance origin of a canvas note (#31, PD-009): AI-created vs user-drawn. */
export type NoteOrigin = "ai" | "user";

/**
 * Lifecycle state of an idea card (#20, PD-012). Minimal for now: a card is
 * `active` until something *supersedes* it (a Challenge's refined version, via a
 * `supersedes` edge), at which point it becomes `superseded` — dimmed/archived
 * on the canvas but never deleted, so the path the argument took stays visible.
 * The full captured→exploring→decided→parked/killed machine (#20) extends this
 * union later; `superseded` is the one state PD-012 requires.
 */
export type IdeaLifecycle = "active" | "superseded";

/**
 * Distinct provenance glyph prepended to AI-created card headings (#31, PD-009).
 * Deliberately different from the `kind` badges in {@link KIND_REGISTRY} (✨/⚠/…)
 * so a reader can separate "who made this" from "what kind it is" at a glance.
 */
export const AI_PROVENANCE_BADGE = "🤖";

/**
 * Prefix an AI card's decorated heading with the provenance badge (#31, PD-009)
 * so AI suggestions read e.g. "🤖 ✨ Feature: …" and stay visually distinct from
 * the user's own notes in both the page and edgeless (Canvas) views. User-origin
 * headings are returned unchanged. Idempotent: a heading already carrying the
 * badge is never double-prefixed.
 */
export function decorateProvenance(title: string, origin: NoteOrigin): string {
  if (origin !== "ai") return title;
  if (title.startsWith(`${AI_PROVENANCE_BADGE} `)) return title;
  return `${AI_PROVENANCE_BADGE} ${title}`;
}

/**
 * Map an extracted {@link CreateIdeaInput} to a deterministic block sequence — a `heading`
 * (the title decorated by `kind`) followed by the body. This is NOT structure
 * inference: the shape is dictated by the CreateIdeaInput, not guessed from text. A
 * multi-line (fenced) body is routed through {@link MarkdownBlockParser} so
 * markdown inside it becomes child blocks (§8.3 — the parser's only remaining
 * role: formatting a known idea body, never parsing the raw stream).
 */
export function ideaToDescriptors(idea: CreateIdeaInput): BlockDescriptor[] {
  const out: BlockDescriptor[] = [{ type: "heading", level: 3, text: decorateTitle(idea.title, idea.kind) }];
  const body = idea.body?.trim();
  if (body) {
    const parser = new MarkdownBlockParser();
    out.push(...parser.translateAll(body.split("\n")));
    const tail = parser.flush();
    if (tail) out.push(tail);
  }
  return out;
}
