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
   * Render the VISIBLE viewport to flat text — the `tmux capture-pane -p -J`
   * analog. `baseY` is the buffer index of the viewport's top row while the
   * view is pinned to the bottom (always, here — nothing scrolls the server
   * side up), so the on-screen rows are `baseY .. baseY + rows - 1`. Wrapped
   * continuation rows are joined into one logical line (see {@link #flatten});
   * scrollback above the screen is excluded so the capture shape matches POSIX.
   */
  snapshot(): string {
    const buf = this.#term.buffer.active;
    return this.#flatten(buf.baseY, buf.baseY + this.#rows);
  }

  /**
   * Render the ENTIRE buffer — scrollback above the screen plus the visible
   * viewport — to flat text. The idea scan uses this (not {@link snapshot}) so
   * an `«IDEA»` line that scrolled off between two captures is still caught
   * before xterm trims it from scrollback. Session-scoped dedupe makes the
   * inevitable re-scan of still-visible lines idempotent.
   */
  snapshotAll(): string {
    return this.#flatten(0, this.#term.buffer.active.length);
  }

  /**
   * Flatten buffer rows `[start, end)` to text, JOINING xterm's wrapped
   * continuation rows back into one logical line — the Windows analog of `tmux
   * capture-pane -J`. This is essential, not cosmetic: without it the text of a
   * wrapped line depends on the pane width, so resizing the terminal re-wraps
   * the buffer and the idea scanner's row-rejoin reconstructs a slightly
   * different body at each width. That mints a fresh dedupe key every resize and
   * spawns a duplicate card on every drag (#38). Joining by `isWrapped` yields a
   * width-independent logical line, so a re-rendered idea dedupes to one card.
   */
  #flatten(start: number, end: number): string {
    const buf = this.#term.buffer.active;
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i);
      // Keep the FULL row (no per-row right-trim): a continuation row is full
      // width, so a word-boundary space sitting in its last cell must survive
      // the join or two words would fuse. Trailing pad is trimmed once per
      // logical line below.
      const text = line?.translateToString(false) ?? "";
      // `isWrapped` marks a row as the soft-wrapped continuation of the row
      // above; append it (no separator) rather than starting a new logical line.
      if (line?.isWrapped && out.length > 0) out[out.length - 1] += text;
      else out.push(text);
    }
    return out.map((l) => l.replace(/\s+$/u, "")).join("\n");
  }
}
