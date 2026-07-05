/**
 * Unit test for the active-filter chip model (#108): the pure derivation from a
 * {@link BoardFilter} to the ordered, removable chips shown near the canvas
 * toolbar, and the round-trip that each chip's `remove` clears exactly its own
 * facet and nothing else.
 */
import { describe, it, expect } from "vitest";
import { filterChips } from "./filter-chips";
import { EMPTY_FILTER, type BoardFilter } from "./filter";

describe("filterChips", () => {
  it("is empty for the no-op filter", () => {
    expect(filterChips(EMPTY_FILTER)).toEqual([]);
  });

  it("names one chip per engaged facet", () => {
    const filter: BoardFilter = {
      hiddenKinds: new Set(["risk"]),
      origin: "ai",
      markedOnly: true,
      showSuperseded: false,
      triagedOnly: true
    };
    expect(filterChips(filter).map((c) => ({ id: c.id, label: c.label }))).toEqual([
      { id: "kind-risk", label: "Hidden: ⚠ Risk" },
      { id: "origin", label: "🤖 AI only" },
      { id: "marked", label: "★ Marked only" },
      { id: "triaged", label: "⚖ Triaged only" },
      { id: "superseded", label: "Superseded hidden" }
    ]);
  });

  it("orders hidden kinds by registry order, then unknown tags", () => {
    const filter: BoardFilter = {
      ...EMPTY_FILTER,
      hiddenKinds: new Set(["custom", "feature", "risk"])
    };
    expect(filterChips(filter).map((c) => c.id)).toEqual(["kind-risk", "kind-feature", "kind-custom"]);
  });

  it("labels an unknown hidden kind as a #tag", () => {
    const filter: BoardFilter = { ...EMPTY_FILTER, hiddenKinds: new Set(["spike"]) };
    expect(filterChips(filter)[0].label).toBe("Hidden: #spike");
  });

  it("labels the user-only origin", () => {
    const filter: BoardFilter = { ...EMPTY_FILTER, origin: "user" };
    expect(filterChips(filter)[0].label).toBe("User only");
  });

  it("remove clears only that facet", () => {
    const filter: BoardFilter = {
      hiddenKinds: new Set(["risk", "feature"]),
      origin: "ai",
      markedOnly: true,
      showSuperseded: false,
      triagedOnly: true
    };
    const chips = filterChips(filter);

    const afterRisk = chips.find((c) => c.id === "kind-risk")!.remove(filter);
    expect([...afterRisk.hiddenKinds]).toEqual(["feature"]);
    // Every other facet is untouched.
    expect(afterRisk.origin).toBe("ai");
    expect(afterRisk.markedOnly).toBe(true);
    expect(afterRisk.triagedOnly).toBe(true);
    expect(afterRisk.showSuperseded).toBe(false);

    expect(chips.find((c) => c.id === "origin")!.remove(filter).origin).toBe("all");
    expect(chips.find((c) => c.id === "marked")!.remove(filter).markedOnly).toBe(false);
    expect(chips.find((c) => c.id === "triaged")!.remove(filter).triagedOnly).toBe(false);
    expect(chips.find((c) => c.id === "superseded")!.remove(filter).showSuperseded).toBe(true);
  });

  it("remove does not mutate the input filter", () => {
    const filter: BoardFilter = { ...EMPTY_FILTER, hiddenKinds: new Set(["risk"]) };
    filterChips(filter)[0].remove(filter);
    expect([...filter.hiddenKinds]).toEqual(["risk"]);
  });
});
