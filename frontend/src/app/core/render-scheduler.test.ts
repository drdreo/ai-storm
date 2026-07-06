/**
 * Unit tests for the framerate-throttled {@link RenderScheduler} (#135, PRD §5.1).
 * The shared {@link FrameClockFake} stands in for requestAnimationFrame so we control
 * exactly when frames fire: enqueues only buffer, and a single sink call drains the
 * batch per frame. Covers the double-buffer swap, per-frame cap + overflow carry,
 * synchronous flush, and disposal.
 */
import { describe, it, expect, vi } from "vitest";
import { FrameClockFake } from "../../testing";
import { RenderScheduler } from "./render-scheduler";

function makeScheduler<T>(maxPerFrame = 0) {
  const clock = new FrameClockFake();
  const batches: T[][] = [];
  const scheduler = new RenderScheduler<T>({
    sink: (batch) => batches.push(batch),
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    maxPerFrame
  });
  return { clock, batches, scheduler };
}

describe("RenderScheduler", () => {
  it("buffers enqueues and flushes them as one batch per frame", () => {
    const { clock, batches, scheduler } = makeScheduler<number>();
    scheduler.enqueue(1);
    scheduler.enqueue(2);
    scheduler.enqueue(3);
    // Nothing flushes until the frame fires.
    expect(batches).toEqual([]);
    expect(scheduler.pending).toBe(3);

    clock.tick();
    expect(batches).toEqual([[1, 2, 3]]);
    expect(scheduler.pending).toBe(0);
  });

  it("coalesces many enqueues into a single scheduled frame", () => {
    const { clock, scheduler } = makeScheduler<number>();
    scheduler.enqueue(1);
    scheduler.enqueue(2);
    // Only one frame is outstanding no matter how many items queued.
    expect(clock.scheduled).toBe(1);
  });

  it("enqueueAll appends a whole array and ignores an empty one", () => {
    const { clock, batches, scheduler } = makeScheduler<number>();
    scheduler.enqueueAll([1, 2]);
    scheduler.enqueueAll([]);
    expect(clock.scheduled).toBe(1);
    clock.tick();
    expect(batches).toEqual([[1, 2]]);
  });

  it("does not schedule a frame for an empty enqueueAll", () => {
    const { clock, scheduler } = makeScheduler<number>();
    scheduler.enqueueAll([]);
    expect(clock.scheduled).toBe(0);
    expect(scheduler.pending).toBe(0);
  });

  it("caps items per frame and carries the overflow to the next frame", () => {
    const { clock, batches, scheduler } = makeScheduler<number>(2);
    scheduler.enqueueAll([1, 2, 3, 4, 5]);

    clock.tick();
    expect(batches).toEqual([[1, 2]]);
    // Overflow carried → another frame is already scheduled.
    expect(scheduler.pending).toBe(3);

    clock.tick();
    expect(batches).toEqual([
      [1, 2],
      [3, 4]
    ]);

    clock.tick();
    expect(batches).toEqual([[1, 2], [3, 4], [5]]);
    expect(scheduler.pending).toBe(0);
  });

  it("preserves item order across capped frames", () => {
    const { clock, batches, scheduler } = makeScheduler<number>(3);
    scheduler.enqueueAll([1, 2, 3, 4, 5, 6, 7]);
    clock.tick();
    clock.tick();
    clock.tick();
    expect(batches.flat()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("does not drop items written during the sink (back/front swap)", () => {
    const clock = new FrameClockFake();
    const batches: number[][] = [];
    let scheduler: RenderScheduler<number>;
    scheduler = new RenderScheduler<number>({
      sink: (batch) => {
        batches.push(batch);
        // A producer writing mid-flush must land in the next frame, not vanish.
        if (batches.length === 1) scheduler.enqueue(99);
      },
      requestFrame: clock.requestFrame,
      cancelFrame: clock.cancelFrame
    });
    scheduler.enqueue(1);
    clock.tick();
    expect(batches[0]).toEqual([1]);
    // The write during the sink re-scheduled a frame.
    clock.tick();
    expect(batches[1]).toEqual([99]);
  });

  it("flushNow drains everything synchronously and cancels the pending frame", () => {
    const { clock, batches, scheduler } = makeScheduler<number>();
    scheduler.enqueueAll([1, 2, 3]);
    expect(clock.scheduled).toBe(1);

    scheduler.flushNow();
    expect(batches).toEqual([[1, 2, 3]]);
    expect(scheduler.pending).toBe(0);
    // The frame that was scheduled is cancelled, not left dangling.
    expect(clock.scheduled).toBe(0);
    clock.tick(); // no-op, nothing scheduled
    expect(batches).toEqual([[1, 2, 3]]);
  });

  it("flushNow drains capped overflow in one call without leaving a frame", () => {
    const { clock, batches, scheduler } = makeScheduler<number>(2);
    scheduler.enqueueAll([1, 2, 3, 4, 5]);
    scheduler.flushNow();
    expect(batches.flat()).toEqual([1, 2, 3, 4, 5]);
    expect(scheduler.pending).toBe(0);
    expect(clock.scheduled).toBe(0);
  });

  it("flushNow on an empty buffer is a no-op", () => {
    const { batches, scheduler } = makeScheduler<number>();
    scheduler.flushNow();
    expect(batches).toEqual([]);
  });

  it("ignores enqueues after dispose and cancels a pending frame", () => {
    const { clock, batches, scheduler } = makeScheduler<number>();
    scheduler.enqueue(1);
    scheduler.dispose();
    // The pending frame is cancelled and buffered items are dropped.
    expect(clock.scheduled).toBe(0);
    expect(scheduler.pending).toBe(0);

    scheduler.enqueue(2);
    scheduler.enqueueAll([3, 4]);
    clock.tick();
    expect(batches).toEqual([]);
  });

  it("falls back to setTimeout when no requestFrame is injected", () => {
    vi.useFakeTimers();
    try {
      const batches: number[][] = [];
      const scheduler = new RenderScheduler<number>({ sink: (b) => batches.push(b) });
      scheduler.enqueue(1);
      scheduler.enqueue(2);
      expect(batches).toEqual([]);
      vi.advanceTimersByTime(16);
      expect(batches).toEqual([[1, 2]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
