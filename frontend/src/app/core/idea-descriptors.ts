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
