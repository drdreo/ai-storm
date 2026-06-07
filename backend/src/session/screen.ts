/**
 * `TerminalScreen` — headless VT screen emulation for the Windows (ConPTY)
 * backend (design §5.2).
 *
 * On POSIX, `tmux capture-pane -p` hands the extractor an already-rendered, flat
 * snapshot of the pane — cursor moves, erases and scrolling already applied. On
 * Windows there is no tmux: node-pty/ConPTY emits the RAW VT paint stream, in
 * which a full-screen TUI like `claude` positions text with absolute cursor
 * addressing (`ESC[<row>;<col>H`), relative moves (`ESC[<n>C`) and erases
 * (`ESC[K`). The earlier `SlicingBuffer` only modelled `\n` + `\r`, so it could
 * not reconstruct a cursor-addressed screen — those codes were stripped without
 * being APPLIED and the resulting text was garbled (e.g. "✻Churned" instead of
 * "✻ Churned", and rows concatenated across in-place redraws), so the idea scan
 * saw nonsense.
 *
 * This wraps `@xterm/headless` — the same terminal engine xterm.js renders
 * client-side — as a server-side screen buffer. We feed it the raw bytes and
 * read back a rendered snapshot: the Windows analog of `capture-pane -p`. The
 * shared `IdeaScanner` then runs unchanged, seeing the same capture SHAPE on
 * both platforms ("the byte source differs; the scan rules are shared").
 */

import os from "node:os";
import xtermDefault from "@xterm/headless";

// @xterm/headless ships as CommonJS; the default import is its module.exports.
const xterm = xtermDefault as unknown as typeof import("@xterm/headless");

/** Parse the Windows build number from `os.release()` ("10.0.26200" → 26200). */
function windowsBuildNumber(): number | undefined {
  const build = Number(os.release().split(".")[2]);
  return Number.isFinite(build) ? build : undefined;
}

export class TerminalScreen {
  readonly #term: InstanceType<typeof xterm.Terminal>;
  #rows: number;

  constructor(cols: number, rows: number) {
    this.#rows = rows;
    this.#term = new xterm.Terminal({
      cols,
      rows,
      scrollback: 1000,
      allowProposedApi: true, // required to read `.buffer` in xterm 5.x
      // Tell xterm the stream is ConPTY-hosted so its line-wrapping heuristics
      // match the backend (modern ConPTY emits native wrap sequences).
      windowsPty: { backend: "conpty", buildNumber: windowsBuildNumber() },
    });
  }

  /** Feed raw PTY bytes; resolves once xterm has parsed them (in arrival order). */
  write(data: string): Promise<void> {
    return new Promise((resolve) => this.#term.write(data, resolve));
  }

  resize(cols: number, rows: number): void {
    this.#rows = rows;
    this.#term.resize(cols, rows);
  }

  /**
   * Render the VISIBLE viewport to flat text — the `tmux capture-pane -p`
   * analog. `baseY` is the buffer index of the viewport's top row while the
   * view is pinned to the bottom (always, here — nothing scrolls the server
   * side up), so the on-screen rows are `baseY .. baseY + rows - 1`. Each line
   * is right-trimmed; scrollback above the screen is excluded so the capture
   * shape matches POSIX.
   */
  snapshot(): string {
    const buf = this.#term.buffer.active;
    return this.#logicalLines(buf.baseY, buf.baseY + this.#rows).join("\n");
  }

  /**
   * Render the ENTIRE buffer — scrollback above the screen plus the visible
   * viewport — to flat text. The idea scan uses this (not {@link snapshot}) so
   * an `«IDEA»` line that scrolled off between two captures is still caught
   * before xterm trims it from scrollback. Session-scoped dedupe makes the
   * inevitable re-scan of still-visible lines idempotent.
   */
  snapshotAll(): string {
    return this.#logicalLines(0, this.#term.buffer.active.length).join("\n");
  }

  /**
   * Reconstruct LOGICAL lines from grid rows `[from, to)`, rejoining a terminal
   * SOFT-wrap (an auto-wrap continuation — `isWrapped`) onto its start row with
   * NO separator. This is the Windows analog of `tmux capture-pane -J`, and it
   * is load-bearing for idea dedupe (#38).
   *
   * Auto-wrap breaks at the column, not at spaces, so a word can split mid-token
   * ("resili│ence"). Reading the grid row-by-row and letting the scanner rejoin
   * the halves with a space yields "resili ence" — and, worse, the split column
   * MOVES when the pane is resized, so the SAME idea reads differently after
   * every resize and the scanner re-emits it as "new", duplicating every card.
   * Concatenating `isWrapped` rows with no separator recovers the original line
   * ("resilience") identically at any width. `translateToString(false)` keeps
   * each row's full width (no right-trim) so a wrap that lands on a real space
   * preserves it on the next row; only the assembled line's tail is trimmed.
   */
  #logicalLines(from: number, to: number): string[] {
    const buf = this.#term.buffer.active;
    const lines: string[] = [];
    let i = Math.max(0, from);
    const end = Math.min(to, buf.length);
    while (i < end) {
      let text = buf.getLine(i)?.translateToString(false) ?? "";
      let j = i + 1;
      // Absorb auto-wrap continuations (they may run past `end` to complete the
      // logical line — bounded only by the buffer).
      while (j < buf.length && buf.getLine(j)?.isWrapped) {
        text += buf.getLine(j)?.translateToString(false) ?? "";
        j++;
      }
      lines.push(text.replace(/\s+$/, "")); // trim only the assembled line's tail
      i = j;
    }
    return lines;
  }
}
