/**
 * A hand-driven `requestAnimationFrame` stand-in for testing frame-throttled code
 * (e.g. the render scheduler). `requestFrame` stores the callback instead of
 * running it; {@link FrameClockFake.tick} fires every callback scheduled so far —
 * mirroring how the browser coalesces many requests into one frame boundary.
 *
 * `requestFrame`/`cancelFrame` are arrow-bound fields so they can be passed detached
 * (as `requestFrame`/`cancelFrame` options) without losing `this`.
 */
export class FrameClockFake {
  #next = 1;
  #pending = new Map<number, () => void>();

  requestFrame = (cb: () => void): number => {
    const handle = this.#next++;
    this.#pending.set(handle, cb);
    return handle;
  };

  cancelFrame = (handle: number): void => {
    this.#pending.delete(handle);
  };

  /** Fire every callback scheduled as of now (one real frame boundary). */
  tick(): void {
    const cbs = [...this.#pending.values()];
    this.#pending.clear();
    for (const cb of cbs) cb();
  }

  /** How many frames are currently outstanding. */
  get scheduled(): number {
    return this.#pending.size;
  }
}
