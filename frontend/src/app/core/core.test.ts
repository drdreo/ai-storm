/**
 * Tests for the framework-agnostic ingestion engine (PRD §3.3, §5.1).
 * Run with: pnpm test (Vitest — see frontend/package.json and vitest.config.ts).
 *
 * NOTE: ANSI cleaning (`ansi.ts`) and the line/slicing buffer (`slicing-buffer.ts`)
 * moved backend-side when response extraction became a backend concern — their
 * tests now live in `backend/src/session/{ansi,line-buffer}.test.ts`. The
 * frontend keeps only the structural pipeline it still owns: the
 * `MarkdownBlockParser` and the `RenderScheduler`.
 */

import { describe, it, expect } from "vitest";
import { MarkdownBlockParser } from "./markdown-block-parser";
import { RenderScheduler } from "./render-scheduler";

describe("MarkdownBlockParser", () => {
  it("detects headings", () => {
    const p = new MarkdownBlockParser();
    expect(p.translate("## Title here")).toEqual({
      type: "heading",
      level: 2,
      text: "Title here"
    });
  });

  it("detects checkbox before bullet", () => {
    const p = new MarkdownBlockParser();
    expect(p.translate("- [x] done task")).toEqual({
      type: "todo",
      checked: true,
      text: "done task"
    });
    expect(p.translate("- [ ] open task")).toEqual({
      type: "todo",
      checked: false,
      text: "open task"
    });
  });

  it("detects bullets and numbered lists", () => {
    const p = new MarkdownBlockParser();
    expect(p.translate("* a bullet")?.type).toBe("bulleted");
    expect(p.translate("3) third item")).toEqual({
      type: "numbered",
      order: 3,
      text: "third item"
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
      text: "const x = 1;\nconst y = 2;"
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
      text: "just some prose"
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
      cancelFrame: () => {}
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
      maxPerFrame: 2
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
      cancelFrame: () => {}
    });
    scheduler.enqueueAll([1, 2, 3]);
    scheduler.flushNow();
    expect(batches).toEqual([[1, 2, 3]]);
  });

  it("flushNow leaves no dangling frame after overflow drain", () => {
    const cancelledHandles: number[] = [];
    let nextHandle = 1;
    const scheduler = new RenderScheduler<number>({
      sink: () => {},
      requestFrame: (cb) => {
        void cb;
        return nextHandle++;
      },
      cancelFrame: (h) => cancelledHandles.push(h),
      maxPerFrame: 2
    });

    scheduler.enqueueAll([1, 2, 3, 4, 5]);
    scheduler.flushNow();
    expect(scheduler.pending).toBe(0);
    const lastHandle = nextHandle - 1;
    expect(cancelledHandles.includes(lastHandle)).toBe(true);
  });
});
