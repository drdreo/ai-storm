/**
 * The ref-namespace rule (idea-graph §4, mcp-idea-capture §3.3): the canvas
 * mint counter counts only its own `a<n>` refs, so backend-minted `i<n>` refs
 * (honoured into `meta.ref` by `applyIdeas`) can never collide with — or
 * perturb — the canvas's `a<n>` sequence.
 */
import { describe, it, expect } from "vitest";
import { CANVAS_MINT_REF, canvasRefIndex } from "./refs";

describe("canvasRefIndex", () => {
  it("parses canvas-minted a<n> refs", () => {
    expect(canvasRefIndex("a1")).toBe(1);
    expect(canvasRefIndex("a42")).toBe(42);
  });

  it("ignores backend-minted i<n> refs (disjoint MCP namespace)", () => {
    expect(canvasRefIndex("i1")).toBe(0);
    expect(canvasRefIndex("i999")).toBe(0);
  });

  it("ignores absent and foreign refs", () => {
    expect(canvasRefIndex(undefined)).toBe(0);
    expect(canvasRefIndex("")).toBe(0);
    expect(canvasRefIndex("a")).toBe(0); // no index
    expect(canvasRefIndex("a1x")).toBe(0); // not a pure mint ref
    expect(canvasRefIndex("ai3")).toBe(0);
    expect(canvasRefIndex("b7")).toBe(0); // fenced agent-stamped ids, user refs
  });

  it("anchors the pattern at both ends (no substring matches)", () => {
    expect(CANVAS_MINT_REF.test("xa1")).toBe(false);
    expect(CANVAS_MINT_REF.test("a1!")).toBe(false);
  });
});
