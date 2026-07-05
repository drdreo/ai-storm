/**
 * Tests for ANSI cleaning, moved backend-side with the code (design §6/§7):
 * the response layer is now extracted on the backend, so the cleaning that used
 * to run client-side lives here. Run with: pnpm test (Vitest).
 */

import { describe, it, expect } from "vitest";
import { sanitize, stripAnsi } from "./ansi.ts";

const ESC = String.fromCharCode(0x1b);

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
    const input = `a${String.fromCharCode(0x00)}b\tc\nd${String.fromCharCode(0x7f)}`;
    expect(sanitize(input)).toBe("ab\tc\nd");
  });
});
