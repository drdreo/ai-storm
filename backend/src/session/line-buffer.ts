/**
 * The Slicing & Chunking Buffer (PRD §3.3).
 *
 * A stateful text accumulator that ingests raw fragments arriving from a PTY
 * byte stream. It makes NO assumption that lines or delimiters arrive cleanly:
 * bytes are buffered until a structural boundary (newline) can be verified at
 * the character level. Carriage returns are resolved as in-place line rewrites
 * (the mechanism behind spinners / progress bars), and a trailing fragment that
 * would split an ANSI escape is held back until the rest of the sequence lands.
 *
 * On POSIX the tmux backend gets pre-flattened text from `capture-pane`, so it
 * does not need this. On Windows the node-pty backend feeds the raw PTY stream
 * through this buffer to reconstruct logical lines + a live pending line, then
 * hands them to the shared response extractor (design §5.2). It moved here from
 * the client (`frontend/src/app/core/slicing-buffer.ts`) along with `ansi.ts`.
 *
 * Output is a sequence of *completed logical lines* (sanitised), plus a live
 * view of the still-pending partial line.
 */

import { sanitize, endsWithPartialEscape } from "./ansi.ts";

export interface SliceResult {
  /** Lines whose terminating newline has been confirmed, fully sanitised. */
  lines: string[];
  /** The current, not-yet-terminated line (sanitised), for live display. */
  pending: string;
}

export class SlicingBuffer {
  /** Raw, un-sanitised carry of bytes that may contain a partial escape. */
  #raw = "";
  /**
   * The working line being assembled at the character level. Carriage returns
   * rewrite this in place rather than appending, mirroring a real terminal.
   */
  #line = "";
  /**
   * True when the last character of the previous chunk was a lone `\r` whose
   * CRLF-vs-rewrite meaning cannot be determined until the next chunk arrives.
   */
  #pendingCR = false;

  /**
   * Push a raw fragment from the stream and return any newly completed lines.
   * Safe to call with arbitrarily-sliced input — including a single byte, a
   * fragment ending mid-escape, or several lines at once.
   */
  push(fragment: string): SliceResult {
    this.#raw += fragment;

    // Hold back a trailing partial escape sequence; we cannot sanitise it yet
    // without corrupting the eventual complete sequence.
    let workable = this.#raw;
    let carry = "";
    if (endsWithPartialEscape(workable)) {
      const escIdx = Math.max(
        workable.lastIndexOf(String.fromCharCode(0x1b)),
        workable.lastIndexOf(String.fromCharCode(0x9b)),
      );
      carry = workable.slice(escIdx);
      workable = workable.slice(0, escIdx);
    }
    this.#raw = carry;

    const completed: string[] = [];

    // Resolve a CR that was held back from the previous chunk now that we can
    // see the character that follows it.
    if (this.#pendingCR) {
      this.#pendingCR = false;
      if (workable.length > 0 && workable[0] === "\n") {
        // CRLF across chunks: emit the buffered line and skip the leading \n.
        completed.push(sanitize(this.#line));
        this.#line = "";
        workable = workable.slice(1);
      } else {
        // Bare CR at end of previous chunk: in-place rewrite (spinner frame).
        this.#line = "";
      }
    }

    // Walk the workable text character by character, resolving \r and \n.
    for (let i = 0; i < workable.length; i++) {
      const ch = workable[i];
      if (ch === "\n") {
        completed.push(sanitize(this.#line));
        this.#line = "";
      } else if (ch === "\r") {
        if (i === workable.length - 1) {
          // Trailing lone \r — defer the CR/LF-vs-rewrite decision until the
          // next chunk arrives so a CRLF split across chunks is not lost.
          this.#pendingCR = true;
        } else if (workable[i + 1] === "\n") {
          // Carriage return: if followed by \n it's a CRLF newline (handled by
          // the \n branch on the next iteration).
          continue; // let the \n complete the line
        } else {
          this.#line = ""; // in-place rewrite (spinner/progress frame)
        }
      } else {
        this.#line += ch;
      }
    }

    return { lines: completed, pending: sanitize(this.#line) };
  }

  /** The current pending (incomplete) line, sanitised. */
  get pending(): string {
    return sanitize(this.#line);
  }

  /**
   * Flush any buffered content as a final line (e.g. on stream close or PTY
   * exit when the last line has no trailing newline).
   */
  flush(): string[] {
    const out: string[] = [];
    // A held-back CR at end-of-stream acts as a plain rewrite: the current
    // line is already in #line (the CR cleared nothing yet), so we just clear
    // the flag; the content in #line will be emitted below if non-empty.
    this.#pendingCR = false;
    // Sanitise any carried raw bytes even if they were a dangling escape.
    const tail = sanitize(this.#line + this.#raw);
    if (tail.length > 0) out.push(tail);
    this.#line = "";
    this.#raw = "";
    return out;
  }

  reset(): void {
    this.#raw = "";
    this.#line = "";
    this.#pendingCR = false;
  }
}
