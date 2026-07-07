/**
 * Tests for the guided-tour gating and step catalog (#179): the auto-start
 * decision, the kill switch, and the invariants the intro catalog must hold
 * (anchored selectors, empty-state coexistence).
 */

import { describe, it, expect } from "vitest";
import {
  INTRO_TOUR_STEPS,
  POWER_TOUR_MIN_CARDS,
  POWER_TOUR_STEPS,
  shouldOfferIntro,
  shouldOfferPower,
  type PowerTourMilestone,
  type TourGates
} from "./tours";

function gates(overrides: Partial<TourGates> = {}): TourGates {
  return { killSwitch: null, intro: null, power: null, ...overrides };
}

function milestone(overrides: Partial<PowerTourMilestone> = {}): PowerTourMilestone {
  return { attached: true, cardCount: POWER_TOUR_MIN_CARDS, ...overrides };
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

describe("shouldOfferPower (#179)", () => {
  it("offers once the milestone is reached — attached session and enough cards", () => {
    expect(shouldOfferPower(gates(), milestone())).toBe(true);
  });

  it("never offers before a session is attached, regardless of board size", () => {
    expect(shouldOfferPower(gates(), milestone({ attached: false, cardCount: 50 }))).toBe(false);
  });

  it("never offers below the card threshold", () => {
    expect(shouldOfferPower(gates(), milestone({ cardCount: POWER_TOUR_MIN_CARDS - 1 }))).toBe(false);
  });

  it("is strictly one-shot — done, dismissed, or any persisted value blocks it", () => {
    for (const power of ["done", "dismissed", "garbage"]) {
      expect(shouldOfferPower(gates({ power }), milestone())).toBe(false);
    }
  });

  it("is suppressed entirely by the as:tours=off kill switch", () => {
    expect(shouldOfferPower(gates({ killSwitch: "off" }), milestone())).toBe(false);
  });

  it("is independent of the intro tour's outcome", () => {
    expect(shouldOfferPower(gates({ intro: "done" }), milestone())).toBe(true);
  });
});

describe("tour catalogs (#179)", () => {
  const catalogs = [
    ["intro", INTRO_TOUR_STEPS],
    ["power", POWER_TOUR_STEPS]
  ] as const;

  it.each(catalogs)("%s: targets stable anchors (or is an unanchored centered step)", (_name, steps) => {
    for (const step of steps) {
      if (step.placement === "center") {
        expect(step.target).toBe("body");
      } else {
        // Our own data-tour anchors, or a data-testid tldraw ships on its
        // native chrome (e.g. the ☰ main-menu trigger).
        expect(step.target).toMatch(/^\[data-(tour|testid)="[a-z.-]+"\]$/);
      }
    }
  });

  it.each(catalogs)("%s: has a title and content on every step", (_name, steps) => {
    for (const step of steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.content.length).toBeGreaterThan(0);
    }
  });

  it("power: state-dependent surfaces (verb bar, focus mode) are centered, not gated", () => {
    expect(POWER_TOUR_STEPS[0].placement).toBe("center");
    expect(POWER_TOUR_STEPS[POWER_TOUR_STEPS.length - 1].placement).toBe("center");
  });
});
