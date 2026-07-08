/**
 * Initial-size estimation for a new idea card (#215) — the pure text-measurement
 * math that picks a card's `w`/`h` from its content BEFORE creation. Once a card
 * exists the user's manual resize is the source of truth, so this never runs on
 * an existing card. Canvas-measurement based when a DOM is present, with a
 * char-width fallback for the headless (vitest) env.
 */
import { normalizeKind } from "../../idea-descriptors";
import { CARD_MAX_W, CARD_W, type Origin } from "./schema";

const CARD_HORIZONTAL_PADDING = 24;
const CARD_VERTICAL_PADDING = 20;
const CARD_META_ROW_H = 17;
const CARD_GAP = 5;
const CARD_TITLE_LINE_H = 18;
const CARD_BODY_LINE_H = 17;
const CARD_TITLE_CHAR_W = 7.5;
const CARD_BODY_CHAR_W = 6.2;

export interface IdeaCardSizeInput {
  kind?: string;
  title?: string;
  body?: string;
  origin?: Origin;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function measuredTextWidth(text: string, font: string): number | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.font = font;
  return ctx.measureText(text).width;
}

function measuredLineCount(text: string, usableWidth: number, font: string): number | undefined {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  ctx.font = font;

  let lines = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const words = rawLine.trimEnd().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines += 1;
      continue;
    }

    let current = "";
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (ctx.measureText(next).width <= usableWidth) {
        current = next;
        continue;
      }
      if (current) lines += 1;
      current = word;
    }
    lines += current ? Math.max(1, Math.ceil(ctx.measureText(current).width / usableWidth)) : 1;
  }
  return lines;
}

function estimatedLineCount(text: string, usableWidth: number, charWidth: number, font: string): number {
  const measured = measuredLineCount(text, usableWidth, font);
  if (measured != null) return measured;

  const charsPerLine = Math.max(1, Math.floor(usableWidth / charWidth));
  return text
    .split(/\r?\n/)
    .reduce((sum, line) => sum + Math.max(1, Math.ceil(line.trimEnd().length / charsPerLine)), 0);
}

/**
 * Estimate an idea card's initial size from its content (#215). This runs only
 * before creation: once the card exists, the user's manual resize is the source
 * of truth and edits do not auto-resize it out from under them.
 */
export function ideaCardSizeForContent(input: IdeaCardSizeInput): { w: number; h: number } {
  const title = input.title?.trim() || "Untitled idea";
  const body = input.body?.trim() ?? "";
  const normalizedKind = normalizeKind(input.kind);
  const hasMetaRow = input.origin === "ai" || !!normalizedKind;

  const titleFont = "600 14px tldraw_sans, sans-serif";
  const bodyFont = "12px tldraw_sans, sans-serif";
  const titleTextWidth = measuredTextWidth(title, titleFont) ?? title.length * CARD_TITLE_CHAR_W;
  const titleWidth = Math.ceil(titleTextWidth + CARD_HORIZONTAL_PADDING + 34 + 2);
  const bodyWidth = body
    ? Math.ceil(
        body
          .split(/\r?\n/)
          .reduce(
            (max, line) =>
              Math.max(max, measuredTextWidth(line.trimEnd(), bodyFont) ?? line.trimEnd().length * CARD_BODY_CHAR_W),
            0
          ) +
          CARD_HORIZONTAL_PADDING +
          2
      )
    : 0;
  const w = clamp(Math.max(CARD_W, titleWidth, bodyWidth), CARD_W, CARD_MAX_W);

  const usableWidth = w - CARD_HORIZONTAL_PADDING - 2;
  const titleLines = estimatedLineCount(title, usableWidth - 22, CARD_TITLE_CHAR_W, titleFont);
  const bodyLines = body ? estimatedLineCount(body, usableWidth, CARD_BODY_CHAR_W, bodyFont) : 0;
  const contentH =
    2 +
    CARD_VERTICAL_PADDING +
    (hasMetaRow ? CARD_META_ROW_H + CARD_GAP : 0) +
    titleLines * CARD_TITLE_LINE_H +
    (bodyLines > 0 ? CARD_GAP + bodyLines * CARD_BODY_LINE_H : 0);

  return { w, h: Math.ceil(contentH) };
}
