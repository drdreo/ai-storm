import { describe, expect, it } from "vitest";
import { CARD_H, CARD_MAX_H, CARD_MAX_W, CARD_W, ideaCardSizeForContent } from "./idea-card";

describe("ideaCardSizeForContent", () => {
  it("keeps terse cards at the default size", () => {
    expect(ideaCardSizeForContent({ title: "Short", body: "Tiny", origin: "ai" })).toEqual({ w: CARD_W, h: CARD_H });
  });

  it("grows wider for long titles without exceeding the cap", () => {
    const size = ideaCardSizeForContent({
      title: "A deliberately long card title that should not be squeezed into the default width",
      body: "",
      origin: "ai"
    });

    expect(size.w).toBeGreaterThan(CARD_W);
    expect(size.w).toBeLessThanOrEqual(CARD_MAX_W);
    expect(size.h).toBeGreaterThanOrEqual(CARD_H);
  });

  it("grows taller for detailed bodies without exceeding the cap", () => {
    const size = ideaCardSizeForContent({
      title: "Detailed card",
      body: Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: enough detail to need more vertical room.`).join("\n"),
      origin: "ai"
    });

    expect(size.w).toBeGreaterThanOrEqual(CARD_W);
    expect(size.h).toBeGreaterThan(CARD_H);
    expect(size.h).toBeLessThanOrEqual(CARD_MAX_H);
  });
});