/**
 * Tests for `TerminalScreen` — the Windows (ConPTY) headless render that feeds
 * the idea scanner. The risk these guard is #38: resizing the terminal pane
 * re-wraps the buffer, and if the snapshot does not join wrapped continuation
 * rows (the `tmux capture-pane -J` analog the POSIX backend gets for free) the
 * scanner reconstructs a slightly different body at each width, mints a fresh
 * dedupe key, and spawns a duplicate card on every resize.
 */

import { describe, it, expect } from "vitest";
import { TerminalScreen } from "./screen.ts";
import { IdeaScanner } from "./extraction.ts";

describe("TerminalScreen — wrapped-line join (capture-pane -J analog)", () => {
  it("renders a width-wrapped «IDEA» as one logical line, stable across resize", async () => {
    const screen = new TerminalScreen(40, 12);
    // A single-line idea whose body is far longer than 40 cols → xterm soft-wraps
    // it across several buffer rows, marking the continuations isWrapped.
    const idea =
      "«IDEA:risk» Token leak on reconnect :: a refresh races the reattach and can leak the live session token";
    await screen.write(idea + "\r\n");

    const wide = screen.snapshotAll();
    const markerLine = (s: string) => s.split("\n").find((l) => l.includes("«IDEA"));
    // The wrapped body is rejoined into ONE marker line, with word spacing intact.
    expect(s_count(wide, "«IDEA")).toBe(1);
    expect(markerLine(wide)).toContain("races the reattach and can leak");
    expect(markerLine(wide)).not.toMatch(/\b(reattachand|leakthe)\b/); // no fused words

    // Dragging the pane narrower re-wraps the buffer; the logical line must not move.
    screen.resize(20, 12);
    expect(markerLine(screen.snapshotAll())).toBe(markerLine(wide));
    // …and wider again.
    screen.resize(60, 12);
    expect(markerLine(screen.snapshotAll())).toBe(markerLine(wide));
  });

  it("does not spawn duplicate ideas when the pane is resized (#38)", async () => {
    const screen = new TerminalScreen(40, 12);
    const scanner = new IdeaScanner();
    // An idea long enough to wrap, with a prompt glyph below so it is terminated
    // (not held back as the growing tail).
    await screen.write(
      "«IDEA» Edgeless canvas :: one tinted note per idea rendered on an infinite pannable edgeless surface\r\n❯\r\n",
    );

    expect(scanner.scan(screen.snapshotAll())).toHaveLength(1);

    // Drag through a range of widths — each reflows the buffer. None may re-emit.
    for (const cols of [30, 24, 18, 52, 40, 16, 64]) {
      screen.resize(cols, 12);
      expect(scanner.scan(screen.snapshotAll())).toEqual([]);
    }
  });
});

/** Count occurrences of a substring (no regex escaping needed). */
function s_count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}
