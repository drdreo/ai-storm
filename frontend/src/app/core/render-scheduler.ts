/**
 * Framerate-throttled render scheduler (PRD §5.1).
 *
 * Decouples network transmission speed from DOM/document-store mutation. Block
 * descriptors accumulate in a virtual buffer and are flushed to the consumer
 * exactly once per browser paint cycle (requestAnimationFrame). This prevents
 * the CRDT store from being flooded with successive micro-mutations under rapid
 * terminal output, while keeping interaction fluid.
 *
 * Double-buffering: producers always write to the "back" buffer; on each frame
 * the back buffer is swapped to the front, drained to the sink, and cleared —
 * so a flush in progress never races with incoming writes.
 */

export type FrameRequester = (cb: () => void) => number;
export type FrameCanceller = (handle: number) => void;

export interface RenderSchedulerOptions<T> {
  /** Called once per frame with all items buffered since the last frame. */
  sink: (batch: T[]) => void;
  /** Defaults to requestAnimationFrame; injectable for tests/SSR. */
  requestFrame?: FrameRequester;
  cancelFrame?: FrameCanceller;
  /**
   * Optional cap on items flushed per frame to bound a single mutation burst;
   * the remainder carries to the next frame. 0 = unbounded.
   */
  maxPerFrame?: number;
}

// Accessed via globalThis so the module type-checks in non-DOM environments
// (Deno tests, SSR) while still binding the real rAF in the browser.
const g = globalThis as unknown as {
  requestAnimationFrame?: (cb: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

function defaultRequestFrame(cb: () => void): number {
  if (typeof g.requestAnimationFrame === "function") {
    return g.requestAnimationFrame(cb);
  }
  // Non-browser fallback (~60fps) so the scheduler is usable in tests.
  return setTimeout(cb, 16) as unknown as number;
}

function defaultCancelFrame(handle: number): void {
  if (typeof g.cancelAnimationFrame === "function") {
    g.cancelAnimationFrame(handle);
  } else {
    clearTimeout(handle);
  }
}

export class RenderScheduler<T> {
  #back: T[] = [];
  #frame: number | null = null;
  #sink: (batch: T[]) => void;
  #requestFrame: FrameRequester;
  #cancelFrame: FrameCanceller;
  #maxPerFrame: number;
  #disposed = false;

  constructor(opts: RenderSchedulerOptions<T>) {
    this.#sink = opts.sink;
    this.#requestFrame = opts.requestFrame ?? defaultRequestFrame;
    this.#cancelFrame = opts.cancelFrame ?? defaultCancelFrame;
    this.#maxPerFrame = opts.maxPerFrame ?? 0;
  }

  /** Buffer one item for the next paint cycle. */
  enqueue(item: T): void {
    if (this.#disposed) return;
    this.#back.push(item);
    this.#scheduleFrame();
  }

  /** Buffer many items for the next paint cycle. */
  enqueueAll(items: T[]): void {
    if (this.#disposed || items.length === 0) return;
    this.#back.push(...items);
    this.#scheduleFrame();
  }

  get pending(): number {
    return this.#back.length;
  }

  #scheduleFrame(): void {
    if (this.#frame !== null) return;
    this.#frame = this.#requestFrame(() => {
      this.#frame = null;
      this.#drain();
    });
  }

  #drain(): void {
    if (this.#back.length === 0) return;

    // Swap front/back so producers writing during the sink don't get dropped.
    let front = this.#back;
    this.#back = [];

    if (this.#maxPerFrame > 0 && front.length > this.#maxPerFrame) {
      const overflow = front.slice(this.#maxPerFrame);
      front = front.slice(0, this.#maxPerFrame);
      // Carry overflow into the next frame's buffer.
      this.#back.unshift(...overflow);
    }

    this.#sink(front);

    // More work (overflow or writes during sink) → schedule another frame.
    if (this.#back.length > 0) this.#scheduleFrame();
  }

  /** Synchronously flush everything pending (e.g. on workspace switch). */
  flushNow(): void {
    if (this.#frame !== null) {
      this.#cancelFrame(this.#frame);
      this.#frame = null;
    }
    while (this.#back.length > 0) this.#drain();
  }

  /** Tear down: cancel pending frame and drop buffered items (PRD §5.2). */
  dispose(): void {
    this.#disposed = true;
    if (this.#frame !== null) {
      this.#cancelFrame(this.#frame);
      this.#frame = null;
    }
    this.#back = [];
  }
}
