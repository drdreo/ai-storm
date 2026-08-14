import { describe, expect, it } from "vitest";
import { CARD_MAX_W, CARD_W, ideaCardSizeForContent } from "./idea-card";
import { ideaCardPresentation, visualKindLabel } from "./idea-card/presentation";

type PresentationProps = Parameters<typeof ideaCardPresentation>[0];

function props(overrides: Partial<PresentationProps> = {}): PresentationProps {
  return {
    kind: "",
    title: "A card",
    body: "",
    origin: "user",
    superseded: false,
    ...overrides
  };
}

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

  it("reserves the intentional header for kindless user notes", () => {
    const aiSize = ideaCardSizeForContent({ title: "Short", body: "Tiny", origin: "ai" });
    const userSize = ideaCardSizeForContent({ title: "Short", body: "Tiny", origin: "user" });

    expect(userSize).toEqual(aiSize);
  });
});

describe("ideaCardPresentation", () => {
  it("identifies AI provenance and renders a normalized kind without legacy emoji", () => {
    const presentation = ideaCardPresentation(
      props({ origin: "ai", kind: " FEATURE ", body: "A generated direction." }),
      {}
    );

    expect(presentation.provenanceLabel).toBe("AI");
    expect(presentation.kindLabel).toBe("Feature");
    expect(presentation.isKindlessNote).toBe(false);
    expect(presentation.showFooter).toBe(false);
    expect(visualKindLabel("custom-kind")).toBe("#custom-kind");
  });

  it("gives a kindless user note a deliberate header without AI provenance", () => {
    const presentation = ideaCardPresentation(props({ title: "Call Sam" }), {});

    expect(presentation.provenanceLabel).toBeUndefined();
    expect(presentation.kindLabel).toBe("Note");
    expect(presentation.isKindlessNote).toBe(true);
    expect(presentation.showFooter).toBe(false);
  });

  it("shows kinded user notes consistently while keeping provenance absent", () => {
    const presentation = ideaCardPresentation(props({ kind: "risk" }), {});

    expect(presentation.provenanceLabel).toBeUndefined();
    expect(presentation.kindLabel).toBe("Risk");
    expect(presentation.isKindlessNote).toBe(false);
  });

  it("keeps AI provenance across edited, done, starred, and low-confidence states", () => {
    const presentation = ideaCardPresentation(props({ origin: "ai", kind: "decision" }), {
      editedByUser: true,
      done: true,
      starred: true,
      score: { impact: 5, effort: 2, confidence: 1 }
    });

    expect(presentation).toMatchObject({
      provenanceLabel: "AI",
      kindLabel: "Decision",
      editedByUser: true,
      done: true,
      starred: true,
      lowConfidence: true,
      showFooter: true
    });
  });

  it("lets superseded state override done without erasing the star", () => {
    const presentation = ideaCardPresentation(props({ origin: "ai", superseded: true }), {
      done: true,
      starred: true
    });

    expect(presentation.superseded).toBe(true);
    expect(presentation.done).toBe(false);
    expect(presentation.starred).toBe(true);
  });

  it("omits an empty footer and reveals it for links or editing actions", () => {
    const empty = ideaCardPresentation(props(), {});
    const linked = ideaCardPresentation(props({ body: "Track drdreo/ai-storm#250" }), {
      links: [
        { url: "https://example.com/spec", label: "Spec" },
        { url: "https://github.com/drdreo/ai-storm/issues/250", label: "Duplicate issue link" }
      ]
    });
    const editing = ideaCardPresentation(props(), {}, true);

    expect(empty.showFooter).toBe(false);
    expect(linked.showFooter).toBe(true);
    expect(linked.issueLinks).toHaveLength(1);
    expect(linked.cardLinks).toEqual([{ url: "https://example.com/spec", label: "Spec" }]);
    expect(editing.showFooter).toBe(true);
  });
});
