/**
 * Unit tests for `ScanGate` — the shared WHEN-to-scan policy (scanner
 * hardening; mcp-idea-capture §1.1/§1.2, §7). Pure timing, so the whole matrix
 * runs on vitest fake timers: push mode (Windows node-pty: debounce + latency
 * cap + resize settle) and query mode (tmux poll: timestamp-only settling, no
 * timers ever armed).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ScanGate } from "./scan-gate.ts";

describe("ScanGate — push mode (Windows debounce)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (onScan: () => void) => new ScanGate({ onScan, quietMs: 175, maxIntervalMs: 500, resizeSettleMs: 500 });

  it("debounces: one scan fires quietMs after the LAST activity of a burst", () => {
    const onScan = vi.fn();
    const gate = make(onScan);
    gate.activity();
    vi.advanceTimersByTime(100);
    gate.activity(); // burst continues → debounce restarts
    vi.advanceTimersByTime(174);
    expect(onScan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); // quiet for 175ms
    expect(onScan).toHaveBeenCalledTimes(1);
    // No further activity → no further scans (no polling loop hides in here).
    vi.advanceTimersByTime(5_000);
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it("coalesces a repaint burst into a single scan of the settled screen", () => {
    const onScan = vi.fn();
    const gate = make(onScan);
    for (let i = 0; i < 10; i++) {
      gate.activity();
      vi.advanceTimersByTime(10); // chunks every 10ms — well inside the debounce
    }
    expect(onScan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(175);
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it("caps latency: a continuous stream still scans at least every maxIntervalMs", () => {
    const onScan = vi.fn();
    const gate = make(onScan);
    // Chunks every 100ms (< quietMs) for 2s: the debounce alone would starve
    // the scan forever; the cap fires it at 500/1000/1500/2000.
    for (let t = 0; t < 2_000; t += 100) {
      gate.activity();
      vi.advanceTimersByTime(100);
    }
    expect(onScan).toHaveBeenCalledTimes(4);
  });

  it("resize opens a settle window: scan only once repaint output stays quiet", () => {
    const onScan = vi.fn();
    const gate = make(onScan);
    gate.resized();
    expect(gate.settling).toBe(true);
    // Repaint streams chunks every 100ms for 1s — the cap is suspended while
    // settling (the frame is known-garbage), so nothing may fire.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(100);
      gate.activity();
    }
    expect(onScan).not.toHaveBeenCalled();
    expect(gate.settling).toBe(true);
    vi.advanceTimersByTime(499); // not yet quiet for the full settle window
    expect(onScan).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(gate.settling).toBe(false);
  });

  it("resize with NO repaint output still scans after the settle window", () => {
    const onScan = vi.fn();
    const gate = make(onScan);
    gate.resized();
    vi.advanceTimersByTime(500);
    expect(onScan).toHaveBeenCalledTimes(1); // a silent pane must not stall the scan
  });

  it("cancel() drops the pending scan but later activity re-arms the gate", () => {
    const onScan = vi.fn();
    const gate = make(onScan);
    gate.activity();
    gate.cancel();
    vi.advanceTimersByTime(5_000);
    expect(onScan).not.toHaveBeenCalled();
    gate.activity(); // reattach path: the gate is still usable
    vi.advanceTimersByTime(175);
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it("dispose() permanently silences the gate", () => {
    const onScan = vi.fn();
    const gate = make(onScan);
    gate.activity();
    gate.dispose();
    gate.activity();
    gate.resized();
    vi.advanceTimersByTime(10_000);
    expect(onScan).not.toHaveBeenCalled();
  });
});

describe("ScanGate — query mode (tmux poll)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("tracks the settle window by timestamp without ever arming a timer", () => {
    const gate = new ScanGate({ resizeSettleMs: 500 }); // no onScan → query mode
    expect(gate.settling).toBe(false);
    gate.resized();
    expect(gate.settling).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // deadlines only — nothing scheduled
    vi.advanceTimersByTime(300);
    gate.activity(); // post-resize repaint chunk → quiet window restarts
    vi.advanceTimersByTime(400); // t=700 < 300+500
    expect(gate.settling).toBe(true);
    vi.advanceTimersByTime(100); // t=800 — quiet for the full settle window
    expect(gate.settling).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("activity outside a settle window is a no-op in query mode", () => {
    const gate = new ScanGate({ resizeSettleMs: 500 });
    gate.activity(); // ordinary streaming — must not open a window or arm timers
    expect(gate.settling).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
