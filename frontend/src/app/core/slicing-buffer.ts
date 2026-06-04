/**
 * The Slicing & Chunking Buffer (PRD §3.3).
 *
 * A stateful text accumulator that ingests raw fragments arriving from the PTY
 * stream. It makes NO assumption that lines or delimiters arrive cleanly: bytes
 * are buffered until a structural boundary (newline) can be verified at the
 * character level. Carriage returns are resolved as in-place line rewrites
 * (the mechanism behind spinners / progress bars), and a trailing fragment that
 * would split an ANSI escape is held back until the rest of the sequence lands.
 *
 * Output is a sequence of *completed logical lines* (sanitised), plus a live
 * view of the still-pending partial line so the UI can show in-progress text.
 */

import { sanitize, endsWithPartialEscape } from "./ansi";

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
        workable.lastIndexOf(String.fromCharCode(0x1B)),
        workable.lastIndexOf(String.fromCharCode(0x9B)),
      );
      carry = workable.slice(escIdx);
      workable = workable.slice(0, escIdx);
    }
    this.#raw = carry;

    const completed: string[] = [];
    // Walk the workable text character by character, resolving \r and \n.
    for (let i = 0; i < workable.length; i++) {
      const ch = workable[i];
      if (ch === "\n") {
        completed.push(sanitize(this.#line));
        this.#line = "";
      } else if (ch === "\r") {
        // Carriage return: if followed by \n it's a CRLF newline (handled by
        // the \n branch on the next iteration); otherwise it rewinds the line.
        if (workable[i + 1] === "\n") {
          continue; // let the \n complete the line
        }
        this.#line = ""; // in-place rewrite (spinner/progress frame)
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
  }
}
