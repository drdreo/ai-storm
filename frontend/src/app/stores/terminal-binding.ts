/**
 * Per-project terminal binding — the lightweight half of the ingestion split
 * that survives attach/detach cycles. Buffers raw PTY chunks until the
 * project's xterm.js component mounts and registers its sink, then flushes and
 * forwards live. Pure (no store/backend imports) so it is unit-testable in the
 * plain Node env.
 */

/** Cap on raw bytes buffered before a terminal mounts, so an attached-but-never-
 *  viewed project cannot grow without bound (oldest chunks are dropped). */
const MAX_BUFFERED_DATA = 256 * 1024;

/** A mounted xterm.js terminal's sink — the component registers these. */
export interface TerminalSink {
  /** Write base64-encoded raw PTY bytes to the terminal. */
  write(dataB64: string): void;
  /** Clear the terminal's scrollback + viewport. */
  clear(): void;
  /** Move keyboard focus into the terminal (bidirectional canvas, #13). */
  focus?(): void;
}

/** One project's terminal state: the mounted sink, or a bounded backlog. */
export class TerminalBinding {
  #sink: TerminalSink | null = null;
  /** Raw `data` chunks (base64) received before the terminal mounted. */
  #buffer: string[] = [];
  #bufferedBytes = 0;
  readonly #maxBufferedBytes: number;

  constructor(maxBufferedBytes = MAX_BUFFERED_DATA) {
    this.#maxBufferedBytes = maxBufferedBytes;
  }

  /** Forward raw PTY bytes to the terminal (or buffer until it mounts). */
  write(dataB64: string): void {
    if (this.#sink) {
      this.#sink.write(dataB64);
      return;
    }
    this.#buffer.push(dataB64);
    this.#bufferedBytes += dataB64.length;
    // Drop oldest chunks past the cap (a never-viewed session must stay bounded).
    while (this.#bufferedBytes > this.#maxBufferedBytes && this.#buffer.length > 1) {
      this.#bufferedBytes -= this.#buffer.shift()!.length;
    }
  }

  /**
   * Bind a mounted terminal. Flushes any data buffered before the terminal
   * mounted, then forwards subsequent `write`s live. Returns an unbind fn the
   * component calls on teardown (a no-op if another sink took over since).
   */
  bind(sink: TerminalSink): () => void {
    this.#sink = sink;
    if (this.#buffer.length > 0) {
      for (const chunk of this.#buffer) sink.write(chunk);
      this.#buffer = [];
      this.#bufferedBytes = 0;
    }
    return () => {
      if (this.#sink === sink) this.#sink = null;
    };
  }

  /** Clear the mounted terminal's display (no-op while unmounted). */
  clear(): void {
    this.#sink?.clear();
  }

  /** Focus the mounted terminal (no-op while unmounted or unsupported). */
  focus(): void {
    this.#sink?.focus?.();
  }
}
