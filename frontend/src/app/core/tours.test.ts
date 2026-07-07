/**
 * Tests for the guided-tour gating and step catalog (#179): the auto-start
 * decision, the kill switch, and the invariants the intro catalog must hold
 * (anchored selectors, empty-state coexistence).
 */

import { describe, it, expect } from "vitest";
import { INTRO_TOUR_STEPS, shouldOfferIntro, type TourGates } from "./tours";

function gates(overrides: Partial<TourGates> = {}): TourGates {
  return { killSwitch: null, intro: null, ...overrides };
}

describe("shouldOfferIntro (#179)", () => {
  it("offers the intro tour on a fresh profile", () => {
    expect(shouldOfferIntro(gates())).toBe(true);
  });

  it("never offers again once finished", () => {
    expect(shouldOfferIntro(gates({ intro: "done" }))).toBe(false);
  });

  it("never offers again once dismissed — skipping counts as seen", () => {
    expect(shouldOfferIntro(gates({ intro: "dismissed" }))).toBe(false);
  });

  it("treats any unexpected persisted value as seen rather than re-running", () => {
    expect(shouldOfferIntro(gates({ intro: "garbage" }))).toBe(false);
  });

  it("is suppressed entirely by the as:tours=off kill switch", () => {
    expect(shouldOfferIntro(gates({ killSwitch: "off" }))).toBe(false);
  });

  it("ignores kill-switch values other than 'off'", () => {
    expect(shouldOfferIntro(gates({ killSwitch: "on" }))).toBe(true);
  });
});

describe("intro tour catalog (#179)", () => {
  it("targets stable data-tour anchors (or is an unanchored centered step)", () => {
    for (const step of INTRO_TOUR_STEPS) {
      if (step.placement === "center") {
        expect(step.target).toBe("body");
      } else {
        expect(step.target).toMatch(/^\[data-tour="[a-z-]+"\]$/);
      }
    }
  });

  it("does not dim the canvas step — it must coexist with CanvasEmptyState", () => {
    const canvas = INTRO_TOUR_STEPS.find((s) => s.target.includes("canvas"));
    expect(canvas?.hideOverlay).toBe(true);
  });

  it("has a title and content on every step", () => {
    for (const step of INTRO_TOUR_STEPS) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.content.length).toBeGreaterThan(0);
    }
  });
});
