/**
 * Tests for `TerminalScreen` — the Windows (ConPTY) headless screen. The focus is
 * reflow stability (#38): a pane resize must NOT change how an already-rendered
 * idea reads, or the scanner re-emits it and the canvas grows a duplicate card.
 */

import { describe, it, expect } from "vitest";
import { TerminalScreen } from "./screen.ts";
import { IdeaScanner } from "./extraction.ts";

describe("TerminalScreen — reflow-stable logical lines (#38)", () => {
  it("rejoins an auto-wrapped idea so resizing the pane doesn't re-emit it", async () => {
    const screen = new TerminalScreen(100, 30);
    const scanner = new IdeaScanner();
    await screen.write("● Sure, here are some ideas:\r\n\r\n");
    await screen.write(
      "  «IDEA» Offline-first canvas :: cache CRDT ops in IndexedDB and replay them on reconnect for resilience\r\n",
    );
    await screen.write("\r\n❯ \r\n");

    const expected = {
      title: "Offline-first canvas",
      body: "cache CRDT ops in IndexedDB and replay them on reconnect for resilience",
    };
    expect(scanner.scan(screen.snapshotAll())).toEqual([expected]);

    // Drag the divider across many widths — each resize reflows the xterm buffer.
    // The reconstructed logical line is identical at every width, so the idea is
    // seen as already-emitted and NOT re-sent (no duplicate cards).
    for (const cols of [60, 45, 80, 37, 120, 52]) {
      screen.resize(cols, 30);
      expect(scanner.scan(screen.snapshotAll())).toEqual([]);
    }
  });

  it("recovers a word the terminal split mid-token at the wrap column", async () => {
    // At width 40 the body must wrap; without isWrapped-aware rejoin the split
    // would inject a spurious space (e.g. "transparent ly").
    const screen = new TerminalScreen(40, 20);
    await screen.write(
      "  «IDEA» Resilience :: reconnect gracefully and transparently across long sessions everywhere\r\n\r\n❯ \r\n",
    );
    expect(new IdeaScanner().scan(screen.snapshotAll())).toEqual([
      { title: "Resilience", body: "reconnect gracefully and transparently across long sessions everywhere" },
    ]);
  });
});
