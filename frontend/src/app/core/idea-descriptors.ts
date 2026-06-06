/**
 * Pure idea → block adapter (extraction-contract §8.2).
 *
 * Kept deliberately free of any BlockSuite / DOM import so it is unit-testable
 * in isolation (like `markdown-block-parser.ts`). `CanvasService` consumes it to
 * render extracted ideas as cards/notes; `IngestionService` consumes it to feed
 * the render scheduler.
 */

import type { Idea } from '@ai-storm/shared';
import { MarkdownBlockParser, type BlockDescriptor } from './markdown-block-parser';

/**
 * Presentation-only decoration for an idea's `kind` (extraction-contract §8.2).
 * Known kinds get a badge; unknown kinds render as a plain `#tag`. This shapes
 * the card heading text — it does not affect the wire contract.
 */
export const KIND_LABEL: Record<string, string> = {
  risk: '⚠ Risk',
  feature: '✨ Feature',
  question: '❓ Question',
  decision: '✅ Decision',
  todo: '☑ Todo',
  heuristic: '💡 Idea',
};

export function decorateTitle(title: string, kind?: string): string {
  if (!kind) return title;
  const label = KIND_LABEL[kind] ?? `#${kind}`;
  return `${label}: ${title}`;
}

/**
 * The kinds AI-Storm recognises (#21). A union over the keys of
 * {@link KIND_LABEL} — the single source of truth for "known" kinds — so a
 * label and a filter chip exist for exactly these and nothing drifts out of sync.
 */
export type IdeaKind = 'risk' | 'feature' | 'question' | 'decision' | 'todo' | 'heuristic';

/** Ordered list of the known {@link IdeaKind}s (#21), e.g. for chip ordering. */
export const KNOWN_KINDS: readonly IdeaKind[] = [
  'risk',
  'feature',
  'question',
  'decision',
  'todo',
  'heuristic',
];

/**
 * Per-kind note-background tint (#21). Values are valid BlockSuite
 * `NoteBackgroundColor` CSS-var strings (palette confirmed against
 * `@blocksuite/affine-model` `consts/note.ts`), so the canvas service can apply
 * them as a note's `background` directly. Kept as plain strings to keep this
 * module BlockSuite-import-free (so it stays unit-testable in the Node env).
 */
export const KIND_BACKGROUND: Record<IdeaKind, string> = {
  risk: '--affine-note-background-red',
  feature: '--affine-note-background-green',
  question: '--affine-note-background-yellow',
  decision: '--affine-note-background-blue',
  todo: '--affine-note-background-teal',
  heuristic: '--affine-note-background-purple',
};

/**
 * Canonicalise an idea's `kind` for use as a map key / chip id (#21): trim and
 * lowercase it, returning `undefined` for a missing or blank value. Pure.
 */
export function normalizeKind(kind?: string): string | undefined {
  const trimmed = kind?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve a kind's note-background tint (#21), normalising first. Returns
 * `undefined` for an unknown, missing, or blank kind so callers can fall back to
 * their default tint. Pure — no BlockSuite dependency.
 */
export function kindBackground(kind?: string): string | undefined {
  const normalized = normalizeKind(kind);
  if (!normalized) return undefined;
  return KIND_BACKGROUND[normalized as IdeaKind];
}

/** Provenance origin of a canvas note (#31, PD-009): AI-created vs user-drawn. */
export type NoteOrigin = 'ai' | 'user';

/**
 * Distinct provenance glyph prepended to AI-created card headings (#31, PD-009).
 * Deliberately different from the `kind` badges in {@link KIND_LABEL} (✨/⚠/…)
 * so a reader can separate "who made this" from "what kind it is" at a glance.
 */
export const AI_PROVENANCE_BADGE = '🤖';

/**
 * Prefix an AI card's decorated heading with the provenance badge (#31, PD-009)
 * so AI suggestions read e.g. "🤖 ✨ Feature: …" and stay visually distinct from
 * the user's own notes in both the page and edgeless (Canvas) views. User-origin
 * headings are returned unchanged. Idempotent: a heading already carrying the
 * badge is never double-prefixed.
 */
export function decorateProvenance(title: string, origin: NoteOrigin): string {
  if (origin !== 'ai') return title;
  if (title.startsWith(`${AI_PROVENANCE_BADGE} `)) return title;
  return `${AI_PROVENANCE_BADGE} ${title}`;
}

/**
 * Map an extracted {@link Idea} to a deterministic block sequence — a `heading`
 * (the title decorated by `kind`) followed by the body. This is NOT structure
 * inference: the shape is dictated by the Idea, not guessed from text. A
 * multi-line (fenced) body is routed through {@link MarkdownBlockParser} so
 * markdown inside it becomes child blocks (§8.3 — the parser's only remaining
 * role: formatting a known idea body, never parsing the raw stream).
 */
export function ideaToDescriptors(idea: Idea): BlockDescriptor[] {
  const out: BlockDescriptor[] = [
    { type: 'heading', level: 3, text: decorateTitle(idea.title, idea.kind) },
  ];
  const body = idea.body?.trim();
  if (body) {
    const parser = new MarkdownBlockParser();
    out.push(...parser.translateAll(body.split('\n')));
    const tail = parser.flush();
    if (tail) out.push(tail);
  }
  return out;
}
