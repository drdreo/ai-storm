/**
 * Tests for the framework-agnostic ingestion engine (PRD §3.3, §5.1).
 * Run with: pnpm test (Vitest — see frontend/package.json and vitest.config.ts).
 */

import { describe, it, expect } from "vitest";
import { sanitize, stripAnsi, endsWithPartialEscape } from "./ansi";
import { SlicingBuffer } from "./slicing-buffer";
import { MarkdownBlockParser } from "./markdown-block-parser";
import { RenderScheduler } from "./render-scheduler";

const ESC = String.fromCharCode(0x1B);

describe("stripAnsi / sanitize", () => {
  it("stripAnsi removes SGR color codes", () => {
    const colored = `${ESC}[31mred${ESC}[0m normal`;
    expect(stripAnsi(colored)).toBe("red normal");
  });

  it("stripAnsi removes cursor moves and erases", () => {
    const input = `${ESC}[2K${ESC}[1Gprogress${ESC}[H`;
    expect(stripAnsi(input)).toBe("progress");
  });

  it("stripAnsi removes OSC window-title sequences", () => {
    const bell = String.fromCharCode(0x07);
    const input = `${ESC}]0;my title${bell}content`;
    expect(stripAnsi(input)).toBe("content");
  });

  it("sanitize strips stray control bytes but keeps tab/newline", () => {
    const input = `a${String.fromCharCode(0x00)}b\tc\nd${String.fromCharCode(0x7F)}`;
    expect(sanitize(input)).toBe("ab\tc\nd");
  });

  it("endsWithPartialEscape detects dangling escape", () => {
    expect(endsWithPartialEscape(`done${ESC}[31`)).toBe(true);
    expect(endsWithPartialEscape(`done${ESC}[31m`)).toBe(false);
    expect(endsWithPartialEscape("plain text")).toBe(false);
  });
});

describe("SlicingBuffer", () => {
  it("assembles lines split across fragments", () => {
    const buf = new SlicingBuffer();
    let lines: string[] = [];
    lines = lines.concat(buf.push("hel").lines);
    lines = lines.concat(buf.push("lo wor").lines);
    lines = lines.concat(buf.push("ld\nsecond line\n").lines);
    expect(lines).toEqual(["hello world", "second line"]);
  });

  it("holds back partial escape across chunks", () => {
    const buf = new SlicingBuffer();
    // First chunk ends mid-escape; nothing should leak into output.
    const r1 = buf.push(`green ${ESC}[3`);
    expect(r1.lines).toEqual([]);
    // Completing the escape + newline yields a clean line.
    const r2 = buf.push(`2mtext${ESC}[0m\n`);
    expect(r2.lines).toEqual(["green text"]);
  });

  it("resolves carriage-return spinner rewrites", () => {
    const buf = new SlicingBuffer();
    // A spinner overwrites the same line several times, then completes.
    buf.push("Loading |\r");
    buf.push("Loading /\r");
    const r = buf.push("Done!\n");
    expect(r.lines).toEqual(["Done!"]);
  });

  it("handles CRLF as a single newline", () => {
    const buf = new SlicingBuffer();
    const r = buf.push("alpha\r\nbeta\r\n");
    expect(r.lines).toEqual(["alpha", "beta"]);
  });

  it("flush emits trailing unterminated line", () => {
    const buf = new SlicingBuffer();
    buf.push("partial line no newline");
    expect(buf.flush()).toEqual(["partial line no newline"]);
  });

  it("handles CRLF split across two push() calls", () => {
    // Regression: \r at end of first chunk, \n at start of next — must yield
    // exactly one completed line ("alpha"), not a spurious empty line.
    const buf = new SlicingBuffer();
    const r1 = buf.push("alpha\r");
    expect(r1.lines).toEqual([]); // no lines yet — CR is held back
    const r2 = buf.push("\nbeta\n");
    expect(r2.lines).toEqual(["alpha", "beta"]);
  });

  it("treats lone \\r at end of chunk as rewrite when next chunk has no \\n", () => {
    // A spinner frame ends a chunk with \r; the rewrite text arrives in the next chunk.
    const buf = new SlicingBuffer();
    const r1 = buf.push("Loading |\r");
    expect(r1.lines).toEqual([]); // no lines yet — CR is held back
    const r2 = buf.push("Loading /\r");
    expect(r2.lines).toEqual([]); // still a rewrite in progress
    const r3 = buf.push("Done!\n");
    expect(r3.lines).toEqual(["Done!"]);
  });
});

describe("MarkdownBlockParser", () => {
  it("detects headings", () => {
    const p = new MarkdownBlockParser();
    expect(p.translate("## Title here")).toEqual({
      type: "heading",
      level: 2,
      text: "Title here",
    });
  });

  it("detects checkbox before bullet", () => {
    const p = new MarkdownBlockParser();
    expect(p.translate("- [x] done task")).toEqual({
      type: "todo",
      checked: true,
      text: "done task",
    });
    expect(p.translate("- [ ] open task")).toEqual({
      type: "todo",
      checked: false,
      text: "open task",
    });
  });

  it("detects bullets and numbered lists", () => {
    const p = new MarkdownBlockParser();
    expect(p.translate("* a bullet")?.type).toBe("bulleted");
    expect(p.translate("3) third item")).toEqual({
      type: "numbered",
      order: 3,
      text: "third item",
    });
  });

  it("accumulates fenced code blocks", () => {
    const p = new MarkdownBlockParser();
    expect(p.translate("```ts")).toBe(null);
    expect(p.translate("const x = 1;")).toBe(null);
    expect(p.translate("const y = 2;")).toBe(null);
    expect(p.translate("```")).toEqual({
      type: "code",
      language: "ts",
      text: "const x = 1;\nconst y = 2;",
    });
  });

  it("detects divider and quote", () => {
    const p = new MarkdownBlockParser();
    expect(p.translate("---")?.type).toBe("divider");
    expect(p.translate("> quoted")).toEqual({ type: "quote", text: "quoted" });
  });

  it("falls back to paragraph", () => {
    const p = new MarkdownBlockParser();
    expect(p.translate("just some prose")).toEqual({
      type: "paragraph",
      text: "just some prose",
    });
  });
});

describe("RenderScheduler", () => {
  it("batches enqueues into one frame", async () => {
    const batches: number[][] = [];
    let fireFrame: (() => void) | null = null;
    const scheduler = new RenderScheduler<number>({
      sink: (batch) => batches.push(batch),
      requestFrame: (cb) => {
        fireFrame = cb;
        return 1;
      },
      cancelFrame: () => {},
    });

    scheduler.enqueue(1);
    scheduler.enqueue(2);
    scheduler.enqueue(3);
    // Nothing flushed until the frame fires.
    expect(batches.length).toBe(0);
    fireFrame!();
    expect(batches).toEqual([[1, 2, 3]]);
    await Promise.resolve();
  });

  it("respects maxPerFrame and carries overflow", () => {
    const batches: number[][] = [];
    const frames: Array<() => void> = [];
    const scheduler = new RenderScheduler<number>({
      sink: (batch) => batches.push(batch),
      requestFrame: (cb) => {
        frames.push(cb);
        return frames.length;
      },
      cancelFrame: () => {},
      maxPerFrame: 2,
    });

    scheduler.enqueueAll([1, 2, 3, 4, 5]);
    frames.shift()!(); // frame 1
    expect(batches[0]).toEqual([1, 2]);
    frames.shift()!(); // frame 2 (scheduled for overflow)
    expect(batches[1]).toEqual([3, 4]);
    frames.shift()!(); // frame 3
    expect(batches[2]).toEqual([5]);
  });

  it("flushNow drains synchronously", () => {
    const batches: number[][] = [];
    const scheduler = new RenderScheduler<number>({
      sink: (batch) => batches.push(batch),
      requestFrame: () => 1,
      cancelFrame: () => {},
    });
    scheduler.enqueueAll([1, 2, 3]);
    scheduler.flushNow();
    expect(batches).toEqual([[1, 2, 3]]);
  });

  it("flushNow leaves no dangling frame after overflow drain", () => {
    // With maxPerFrame=2, draining [1,2,3,4,5] via flushNow must not leave a
    // scheduled frame handle behind once the loop completes.
    const cancelledHandles: number[] = [];
    let nextHandle = 1;
    const scheduler = new RenderScheduler<number>({
      sink: () => {},
      requestFrame: (cb) => {
        // Capture cb so we can verify it is never called spontaneously; just
        // return an incrementing handle so we can track cancel calls.
        void cb;
        return nextHandle++;
      },
      cancelFrame: (h) => cancelledHandles.push(h),
      maxPerFrame: 2,
    });

    scheduler.enqueueAll([1, 2, 3, 4, 5]);
    // flushNow must cancel the initial frame AND any frames scheduled during
    // the overflow drain, so pending drops to 0 with no live handle.
    scheduler.flushNow();
    expect(scheduler.pending).toBe(0);
    // The last handle assigned is the one that must have been cancelled.
    const lastHandle = nextHandle - 1;
    expect(cancelledHandles.includes(lastHandle)).toBe(true);
  });
});
