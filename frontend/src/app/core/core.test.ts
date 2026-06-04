/**
 * Tests for the framework-agnostic ingestion engine (PRD §3.3, §5.1).
 * Run with: deno test core.test.ts
 */

import { assertEquals } from "jsr:@std/assert@1";
import { sanitize, stripAnsi, endsWithPartialEscape } from "./ansi";
import { SlicingBuffer } from "./slicing-buffer";
import { MarkdownBlockParser } from "./markdown-block-parser";
import { RenderScheduler } from "./render-scheduler";

const ESC = String.fromCharCode(0x1B);

Deno.test("stripAnsi removes SGR color codes", () => {
  const colored = `${ESC}[31mred${ESC}[0m normal`;
  assertEquals(stripAnsi(colored), "red normal");
});

Deno.test("stripAnsi removes cursor moves and erases", () => {
  const input = `${ESC}[2K${ESC}[1Gprogress${ESC}[H`;
  assertEquals(stripAnsi(input), "progress");
});

Deno.test("stripAnsi removes OSC window-title sequences", () => {
  const bell = String.fromCharCode(0x07);
  const input = `${ESC}]0;my title${bell}content`;
  assertEquals(stripAnsi(input), "content");
});

Deno.test("sanitize strips stray control bytes but keeps tab/newline", () => {
  const input = `a${String.fromCharCode(0x00)}b\tc\nd${String.fromCharCode(0x7F)}`;
  assertEquals(sanitize(input), "ab\tc\nd");
});

Deno.test("endsWithPartialEscape detects dangling escape", () => {
  assertEquals(endsWithPartialEscape(`done${ESC}[31`), true);
  assertEquals(endsWithPartialEscape(`done${ESC}[31m`), false);
  assertEquals(endsWithPartialEscape("plain text"), false);
});

Deno.test("SlicingBuffer assembles lines split across fragments", () => {
  const buf = new SlicingBuffer();
  let lines: string[] = [];
  lines = lines.concat(buf.push("hel").lines);
  lines = lines.concat(buf.push("lo wor").lines);
  lines = lines.concat(buf.push("ld\nsecond line\n").lines);
  assertEquals(lines, ["hello world", "second line"]);
});

Deno.test("SlicingBuffer holds back partial escape across chunks", () => {
  const buf = new SlicingBuffer();
  // First chunk ends mid-escape; nothing should leak into output.
  const r1 = buf.push(`green ${ESC}[3`);
  assertEquals(r1.lines, []);
  // Completing the escape + newline yields a clean line.
  const r2 = buf.push(`2mtext${ESC}[0m\n`);
  assertEquals(r2.lines, ["green text"]);
});

Deno.test("SlicingBuffer resolves carriage-return spinner rewrites", () => {
  const buf = new SlicingBuffer();
  // A spinner overwrites the same line several times, then completes.
  buf.push("Loading |\r");
  buf.push("Loading /\r");
  const r = buf.push("Done!\n");
  assertEquals(r.lines, ["Done!"]);
});

Deno.test("SlicingBuffer handles CRLF as a single newline", () => {
  const buf = new SlicingBuffer();
  const r = buf.push("alpha\r\nbeta\r\n");
  assertEquals(r.lines, ["alpha", "beta"]);
});

Deno.test("SlicingBuffer flush emits trailing unterminated line", () => {
  const buf = new SlicingBuffer();
  buf.push("partial line no newline");
  assertEquals(buf.flush(), ["partial line no newline"]);
});

Deno.test("MarkdownBlockParser detects headings", () => {
  const p = new MarkdownBlockParser();
  assertEquals(p.translate("## Title here"), {
    type: "heading",
    level: 2,
    text: "Title here",
  });
});

Deno.test("MarkdownBlockParser detects checkbox before bullet", () => {
  const p = new MarkdownBlockParser();
  assertEquals(p.translate("- [x] done task"), {
    type: "todo",
    checked: true,
    text: "done task",
  });
  assertEquals(p.translate("- [ ] open task"), {
    type: "todo",
    checked: false,
    text: "open task",
  });
});

Deno.test("MarkdownBlockParser detects bullets and numbered lists", () => {
  const p = new MarkdownBlockParser();
  assertEquals(p.translate("* a bullet")?.type, "bulleted");
  assertEquals(p.translate("3) third item"), {
    type: "numbered",
    order: 3,
    text: "third item",
  });
});

Deno.test("MarkdownBlockParser accumulates fenced code blocks", () => {
  const p = new MarkdownBlockParser();
  assertEquals(p.translate("```ts"), null);
  assertEquals(p.translate("const x = 1;"), null);
  assertEquals(p.translate("const y = 2;"), null);
  assertEquals(p.translate("```"), {
    type: "code",
    language: "ts",
    text: "const x = 1;\nconst y = 2;",
  });
});

Deno.test("MarkdownBlockParser detects divider and quote", () => {
  const p = new MarkdownBlockParser();
  assertEquals(p.translate("---")?.type, "divider");
  assertEquals(p.translate("> quoted"), { type: "quote", text: "quoted" });
});

Deno.test("MarkdownBlockParser falls back to paragraph", () => {
  const p = new MarkdownBlockParser();
  assertEquals(p.translate("just some prose"), {
    type: "paragraph",
    text: "just some prose",
  });
});

Deno.test("RenderScheduler batches enqueues into one frame", async () => {
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
  assertEquals(batches.length, 0);
  fireFrame!();
  assertEquals(batches, [[1, 2, 3]]);
  await Promise.resolve();
});

Deno.test("RenderScheduler respects maxPerFrame and carries overflow", () => {
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
  assertEquals(batches[0], [1, 2]);
  frames.shift()!(); // frame 2 (scheduled for overflow)
  assertEquals(batches[1], [3, 4]);
  frames.shift()!(); // frame 3
  assertEquals(batches[2], [5]);
});

Deno.test("RenderScheduler flushNow drains synchronously", () => {
  const batches: number[][] = [];
  const scheduler = new RenderScheduler<number>({
    sink: (batch) => batches.push(batch),
    requestFrame: () => 1,
    cancelFrame: () => {},
  });
  scheduler.enqueueAll([1, 2, 3]);
  scheduler.flushNow();
  assertEquals(batches, [[1, 2, 3]]);
});
