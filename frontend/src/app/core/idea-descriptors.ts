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

/**
 * Construct a wire-shaped {@link Idea} from raw human-composer input (#31, PD-002).
 *
 * Pure and BlockSuite/Angular-free so the composer and `CanvasService` share one
 * normalization: a human-authored idea is the exact same object the backend's
 * `idea` stream emits, so it renders identically downstream. `title` is the only
 * required field — returns `null` when it is empty/whitespace-only. `kind` is
 * omitted entirely unless it is a non-empty trimmed string, matching the
 * optional-field convention of the wire {@link Idea} (never `kind: ''`).
 */
export function buildIdea(title: string, body: string, kind?: string): Idea | null {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) return null;
  const idea: Idea = { title: trimmedTitle, body: body.trim() };
  const trimmedKind = kind?.trim();
  if (trimmedKind) idea.kind = trimmedKind;
  return idea;
}

export function decorateTitle(title: string, kind?: string): string {
  if (!kind) return title;
  const label = KIND_LABEL[kind] ?? `#${kind}`;
  return `${label}: ${title}`;
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
