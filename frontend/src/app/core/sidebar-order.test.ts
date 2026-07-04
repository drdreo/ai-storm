/** Tests for the sidebar fractional-index ordering helpers (#128 DnD). */

import { describe, expect, it } from "vitest";
import { compareByOrder, computeOrder, orderAfterAll } from "./sidebar-order";

const item = (order: string | undefined, createdAt = 0) => ({ order, createdAt });

describe("compareByOrder", () => {
  it("sorts by fractional key ascending", () => {
    const list = [item("a2"), item("a0"), item("a1")];
    list.sort(compareByOrder);
    expect(list.map((i) => i.order)).toEqual(["a0", "a1", "a2"]);
  });

  it("sorts keyless items first, tie-broken by createdAt", () => {
    const list = [item("a0", 1), item(undefined, 3), item(undefined, 2)];
    list.sort(compareByOrder);
    expect(list.map((i) => [i.order, i.createdAt])).toEqual([
      [undefined, 2],
      [undefined, 3],
      ["a0", 1]
    ]);
  });

  it("tie-breaks equal keys (possible after a concurrent merge) by createdAt", () => {
    const list = [item("a0", 2), item("a0", 1)];
    list.sort(compareByOrder);
    expect(list.map((i) => i.createdAt)).toEqual([1, 2]);
  });
});

describe("computeOrder", () => {
  it("returns a key between the drop position's neighbors", () => {
    const siblings = [item("a0"), item("a1"), item("a2")];
    const key = computeOrder(siblings, 1);
    expect(key > "a0").toBe(true);
    expect(key < "a1").toBe(true);
  });

  it("drop at the start sorts before every sibling", () => {
    const siblings = [item("a0"), item("a1")];
    expect(computeOrder(siblings, 0) < "a0").toBe(true);
  });

  it("drop at the end sorts after every sibling", () => {
    const siblings = [item("a0"), item("a1")];
    expect(computeOrder(siblings, 2) > "a1").toBe(true);
  });

  it("handles an empty sibling list", () => {
    expect(computeOrder([], 0)).toBeTruthy();
  });

  it("falls back to appending after prev when neighbor keys are degenerate", () => {
    // Equal neighbor keys would make generateKeyBetween throw.
    const siblings = [item("a0"), item("a0")];
    expect(computeOrder(siblings, 1) > "a0").toBe(true);
  });

  it("repeated insertion into the same gap keeps producing distinct ordered keys", () => {
    // Squeeze 50 keys between an ever-tighter lower bound and a fixed upper
    // bound — fractional keys never exhaust the gap (no renormalization needed).
    let lower = item("a0");
    const upper = item("a1");
    for (let i = 0; i < 50; i++) {
      const key = computeOrder([lower, upper], 1);
      expect(key > lower.order!).toBe(true);
      expect(key < upper.order!).toBe(true);
      lower = item(key);
    }
  });
});

describe("orderAfterAll", () => {
  it("appends after the last sibling", () => {
    const siblings = [item("a0"), item("a1")];
    expect(orderAfterAll(siblings) > "a1").toBe(true);
  });
});
