import { describe, expect, it } from "vitest";
import { CARD_MAX_W, CARD_W, ideaCardSizeForContent } from "./idea-card";

describe("ideaCardSizeForContent", () => {
  it("uses a compact content-derived height for terse cards", () => {
    const size = ideaCardSizeForContent({ title: "Short", body: "Tiny", origin: "ai" });

    expect(size.w).toBe(CARD_W);
    expect(size.h).toBeLessThan(100);
  });

  it("grows wider for long titles without exceeding the width cap", () => {
    const size = ideaCardSizeForContent({
      title: "A deliberately long card title that should not be squeezed into the default width",
      body: "",
      origin: "ai"
    });

    expect(size.w).toBeGreaterThan(CARD_W);
    expect(size.w).toBeLessThanOrEqual(CARD_MAX_W);
  });

  it("calculates height from every rendered body line", () => {
    const twelveLineSize = ideaCardSizeForContent({
      title: "Detailed card",
      body: Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: enough detail to need more vertical room.`).join("\n"),
      origin: "ai"
    });
    const twentyFourLineSize = ideaCardSizeForContent({
      title: "Detailed card",
      body: Array.from({ length: 24 }, (_, i) => `Line ${i + 1}: enough detail to need more vertical room.`).join("\n"),
      origin: "ai"
    });

    expect(twelveLineSize.h).toBeGreaterThan(200);
    expect(twentyFourLineSize.h).toBeGreaterThan(twelveLineSize.h + 150);
  });
});
