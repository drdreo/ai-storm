/**
 * Structural Block Translation (PRD §3.3).
 *
 * Scans completed logical lines (from the SlicingBuffer) for Markdown
 * structural indicators at the *start* of a line and emits framework-agnostic
 * block descriptors. The BlockSuite layer consumes these to declare block
 * boundaries — initialising headings, bullets, checkbox task targets, or notes.
 *
 * This module is pure: it knows nothing about BlockSuite or the DOM, so the
 * translation rules are unit-testable in isolation.
 */

export type BlockType =
  | "heading"
  | "bulleted"
  | "numbered"
  | "todo"
  | "quote"
  | "code"
  | "divider"
  | "paragraph";

export interface BlockDescriptor {
  type: BlockType;
  /** The text content with the structural marker removed. */
  text: string;
  /** Heading level 1–6 (only for `heading`). */
  level?: number;
  /** Checked state (only for `todo`). */
  checked?: boolean;
  /** Ordered-list index as written (only for `numbered`). */
  order?: number;
  /** Code fence language label (only for `code`). */
  language?: string;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const TODO = /^[-*+]\s+\[([ xX])\]\s+(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const NUMBERED = /^(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const DIVIDER = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE = /^```(.*)$/;

/**
 * Stateful translator. Holds just enough state to track open code fences so
 * that lines inside a ``` block are accumulated verbatim rather than parsed.
 */
export class MarkdownBlockParser {
  #inFence = false;
  #fenceLang = "";
  #fenceLines: string[] = [];

  /**
   * Translate a single completed line into zero or one block descriptors.
   * Returns null for lines that don't yet complete a block (open fence body).
   */
  translate(line: string): BlockDescriptor | null {
    // Inside a fenced code block: accumulate until the closing fence.
    if (this.#inFence) {
      const fence = FENCE.exec(line);
      if (fence) {
        const descriptor: BlockDescriptor = {
          type: "code",
          text: this.#fenceLines.join("\n"),
          language: this.#fenceLang || undefined,
        };
        this.#inFence = false;
        this.#fenceLang = "";
        this.#fenceLines = [];
        return descriptor;
      }
      this.#fenceLines.push(line);
      return null;
    }

    const fenceOpen = FENCE.exec(line);
    if (fenceOpen) {
      this.#inFence = true;
      this.#fenceLang = fenceOpen[1].trim();
      this.#fenceLines = [];
      return null;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      return { type: "heading", level: heading[1].length, text: heading[2].trim() };
    }

    // Checkbox must be tested before generic bullet (it's a more specific form).
    const todo = TODO.exec(line);
    if (todo) {
      return {
        type: "todo",
        checked: todo[1].toLowerCase() === "x",
        text: todo[2].trim(),
      };
    }

    const bullet = BULLET.exec(line);
    if (bullet) {
      return { type: "bulleted", text: bullet[1].trim() };
    }

    const numbered = NUMBERED.exec(line);
    if (numbered) {
      return { type: "numbered", order: Number(numbered[1]), text: numbered[2].trim() };
    }

    if (DIVIDER.test(line)) {
      return { type: "divider", text: "" };
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      return { type: "quote", text: quote[1].trim() };
    }

    // Plain text — including empty lines, which become empty paragraphs/notes.
    return { type: "paragraph", text: line };
  }

  /**
   * Translate a batch of lines, dropping the nulls. Convenience for the
   * ingestion pipeline which deals in arrays of completed lines.
   */
  translateAll(lines: string[]): BlockDescriptor[] {
    const out: BlockDescriptor[] = [];
    for (const line of lines) {
      const block = this.translate(line);
      if (block) out.push(block);
    }
    return out;
  }

  /** Close any dangling fence (stream ended mid code block). */
  flush(): BlockDescriptor | null {
    if (!this.#inFence) return null;
    const descriptor: BlockDescriptor = {
      type: "code",
      text: this.#fenceLines.join("\n"),
      language: this.#fenceLang || undefined,
    };
    this.#inFence = false;
    this.#fenceLang = "";
    this.#fenceLines = [];
    return descriptor;
  }

  get inFence(): boolean {
    return this.#inFence;
  }
}
