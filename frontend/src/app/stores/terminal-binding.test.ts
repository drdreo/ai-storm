/**
 * Tests for the per-project terminal binding extracted from the ingestion
 * store (#139): pre-mount buffering with the bounded backlog, flush-on-bind,
 * and sink handover semantics.
 */

import { describe, it, expect } from "vitest";
import { TerminalBinding, type TerminalSink } from "./terminal-binding";

function sink(): TerminalSink & { written: string[]; cleared: number; focused: number } {
  const s = {
    written: [] as string[],
    cleared: 0,
    focused: 0,
    write(data: string) {
      s.written.push(data);
    },
    clear() {
      s.cleared++;
    },
    focus() {
      s.focused++;
    }
  };
  return s;
}

describe("TerminalBinding", () => {
  it("buffers pre-mount chunks and flushes them in order on bind", () => {
    const t = new TerminalBinding();
    t.write("a");
    t.write("b");
    const s = sink();
    t.bind(s);
    expect(s.written).toEqual(["a", "b"]);
    t.write("c");
    expect(s.written).toEqual(["a", "b", "c"]);
  });

  it("drops the oldest chunks once the pre-mount backlog exceeds the cap", () => {
    const t = new TerminalBinding(5);
    t.write("111");
    t.write("222");
    t.write("333"); // 9 bytes > 5 → "111" (and then "222") dropped
    const s = sink();
    t.bind(s);
    expect(s.written).toEqual(["333"]);
  });

  it("keeps at least the newest chunk even when it alone exceeds the cap", () => {
    const t = new TerminalBinding(2);
    t.write("oversized");
    const s = sink();
    t.bind(s);
    expect(s.written).toEqual(["oversized"]);
  });

  it("unbind detaches only if no newer sink took over", () => {
    const t = new TerminalBinding();
    const first = sink();
    const unbindFirst = t.bind(first);
    const second = sink();
    t.bind(second);
    unbindFirst(); // stale unbind — second sink must stay bound
    t.write("x");
    expect(first.written).toEqual([]);
    expect(second.written).toEqual(["x"]);
  });

  it("clear/focus reach the mounted sink and no-op while unmounted", () => {
    const t = new TerminalBinding();
    t.clear();
    t.focus(); // unmounted: must not throw
    const s = sink();
    t.bind(s);
    t.clear();
    t.focus();
    expect(s.cleared).toBe(1);
    expect(s.focused).toBe(1);
  });
});
