/**
 * Seed-guard regression tests (PRD §3.5).
 *
 * These pin the exact condition that fixes the reload data-loss bug: a doc that
 * is still rehydrating from IndexedDB (not yet synced) must NEVER be re-seeded,
 * because doing so wipes the content that is about to load. We only seed a
 * genuinely empty doc after its persistence has fully synced.
 */

import { describe, it, expect } from "vitest";
import { shouldSeedDoc } from "./canvas-seed";

describe("shouldSeedDoc", () => {
  it("seeds a genuinely empty doc once its store has synced", () => {
    expect(shouldSeedDoc({ hasRoot: false, synced: true })).toBe(true);
  });

  it("does NOT seed while the store is still loading (the data-loss guard)", () => {
    // The doc looks empty here ONLY because IndexedDB has not finished applying
    // its updates — seeding now would clobber the content about to arrive.
    expect(shouldSeedDoc({ hasRoot: false, synced: false })).toBe(false);
  });

  it("does NOT seed a doc that rehydrated with content", () => {
    expect(shouldSeedDoc({ hasRoot: true, synced: true })).toBe(false);
  });

  it("does NOT seed a content-bearing doc that is still syncing", () => {
    expect(shouldSeedDoc({ hasRoot: true, synced: false })).toBe(false);
  });
});
