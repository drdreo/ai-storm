/**
 * Tests for the line/slicing buffer, moved backend-side with the code (design
 * §6/§7). The Windows node-pty backend uses it to reconstruct logical lines
 * from the raw PTY byte stream before extraction. Run with: pnpm test (Vitest).
 */

import { describe, it, expect } from "vitest";
import { SlicingBuffer } from "./line-buffer.ts";

const ESC = String.fromCharCode(0x1b);

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
    const r1 = buf.push(`green ${ESC}[3`);
    expect(r1.lines).toEqual([]);
    const r2 = buf.push(`2mtext${ESC}[0m\n`);
    expect(r2.lines).toEqual(["green text"]);
  });

  it("resolves carriage-return spinner rewrites", () => {
    const buf = new SlicingBuffer();
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
    const buf = new SlicingBuffer();
    const r1 = buf.push("alpha\r");
    expect(r1.lines).toEqual([]);
    const r2 = buf.push("\nbeta\n");
    expect(r2.lines).toEqual(["alpha", "beta"]);
  });

  it("treats lone \\r at end of chunk as rewrite when next chunk has no \\n", () => {
    const buf = new SlicingBuffer();
    const r1 = buf.push("Loading |\r");
    expect(r1.lines).toEqual([]);
    const r2 = buf.push("Loading /\r");
    expect(r2.lines).toEqual([]);
    const r3 = buf.push("Done!\n");
    expect(r3.lines).toEqual(["Done!"]);
  });
});
