/**
 * Tests for the pure prompt-framing layer of the bidirectional canvas (#13).
 *
 * The framed prompt is typed into the live PTY as an EDITABLE prompt, so the
 * load-bearing invariants are: empty/whitespace selections produce nothing, the
 * selection is embedded verbatim (trimmed), and every template ends with a
 * trailing space and NO trailing newline so the cursor lands ready to type.
 */

import { describe, it, expect } from "vitest";
import type { SpecFormat } from "@ai-storm/shared";
import {
  framePrompt,
  frameReference,
  frameTriage,
  frameSpec,
  PROMPT_TEMPLATES,
  SPEC_FORMATS,
  type PromptIntent,
  type ReferencedIdea
} from "./prompt-framing";

describe("framePrompt", () => {
  it('returns "" for an empty selection', () => {
    expect(framePrompt("")).toBe("");
  });

  it('returns "" for a whitespace-only selection', () => {
    expect(framePrompt("   \n\t  \n ")).toBe("");
  });

  it("frames a single-line selection, embedding it verbatim", () => {
    const out = framePrompt("Use a CRDT store");
    expect(out).toContain("Use a CRDT store");
    expect(out).toBe("Regarding these notes from the canvas:\n\nUse a CRDT store\n\nLet's discuss: ");
  });

  it("frames a multi-line selection, preserving its internal newlines", () => {
    const selection = "# Goal\n- offline first\n- low latency";
    const out = framePrompt(selection);
    expect(out).toContain(selection);
    expect(out.startsWith("Regarding these notes from the canvas:\n\n# Goal")).toBe(true);
  });

  it("trims the selection before framing (leading/trailing whitespace gone)", () => {
    const out = framePrompt("   hello world   ");
    expect(out).toContain("\n\nhello world\n\n");
    expect(out).not.toContain("   hello world");
  });

  it("ends with a trailing space and NO trailing newline (editable-cursor invariant)", () => {
    const out = framePrompt("anything");
    expect(out.endsWith(" ")).toBe(true);
    expect(out.endsWith("\n")).toBe(false);
    expect(out.endsWith("\n ")).toBe(false);
  });

  it("defaults to the 'discuss' intent", () => {
    expect(framePrompt("x")).toBe(framePrompt("x", "discuss"));
  });

  it("honours the invariants for every verb intent (#15)", () => {
    const intents: PromptIntent[] = ["discuss", "expand", "challenge", "find-risks"];
    for (const intent of intents) {
      const out = framePrompt("Use a CRDT store", intent);
      // Selection embedded verbatim, trailing space, no trailing newline.
      expect(out).toContain("Use a CRDT store");
      expect(out.endsWith(" ")).toBe(true);
      expect(out.endsWith("\n")).toBe(false);
      // Empty selection still yields nothing regardless of intent.
      expect(framePrompt("   ", intent)).toBe("");
    }
  });

  it("frames each verb distinctly (#15)", () => {
    const expand = framePrompt("S", "expand");
    const challenge = framePrompt("S", "challenge");
    const risks = framePrompt("S", "find-risks");
    expect(expand).not.toBe(challenge);
    expect(challenge).not.toBe(risks);
    expect(expand).toContain("Expand on this idea");
    expect(challenge).toContain("stress-test");
    expect(challenge).toContain("stronger version");
    expect(risks).toContain("risks");
  });
});

describe("framePrompt — source ref injection (#42)", () => {
  it("prepends a tagging directive carrying the source ref", () => {
    const out = framePrompt("Use a CRDT store", "find-risks", "a1");
    expect(out).toContain("@a1");
    // The directive leads; the selection + open clause still follow.
    expect(out.indexOf("@a1")).toBeLessThan(out.indexOf("Use a CRDT store"));
  });

  it("keeps the editable-cursor invariant with a ref (trailing space, no newline)", () => {
    const out = framePrompt("S", "expand", "a3");
    expect(out.endsWith(" ")).toBe(true);
    expect(out.endsWith("\n")).toBe(false);
  });

  it("is identical to the no-ref form when sourceRef is omitted", () => {
    expect(framePrompt("S", "discuss")).toBe(framePrompt("S", "discuss", undefined));
  });

  it("still yields nothing for an empty selection even with a ref", () => {
    expect(framePrompt("   ", "discuss", "a1")).toBe("");
  });

  it("uses the generic about directive for non-challenge verbs (#42)", () => {
    for (const intent of ["discuss", "expand", "find-risks"] as PromptIntent[]) {
      const out = framePrompt("S", intent, "a1");
      expect(out).toContain("@a1");
      // The about directive supplies the ref; it never asks for a supersede.
      expect(out).not.toContain("@a1!");
    }
  });

  it("NO verb echoes an «IDEA» marker token the backend would re-extract", () => {
    // The directive is echoed onto the terminal and re-scanned for markers, so
    // it must contain NO «IDEA»/<<IDEA token at all (not just not line-leading —
    // terminal wrapping can push any inline token to a row start). The marker
    // grammar is taught by the (never-echoed) priming instead.
    const intents: PromptIntent[] = ["discuss", "expand", "challenge", "find-risks"];
    for (const intent of intents) {
      const out = framePrompt("Use a CRDT store", intent, "a1");
      expect(out).not.toContain("«IDEA");
      expect(out).not.toContain("<<IDEA");
    }
  });
});

describe("framePrompt — challenge supersede directive (#20/#22, PD-012)", () => {
  it("instructs the supersedes relation via the trailing `!` ref token", () => {
    const out = framePrompt("Use a CRDT store", "challenge", "a1");
    // The supersede relation rides the single-line marker via a trailing `!`
    // (the fenced form is unreliable — the TUI renders the fence away, PD-008).
    expect(out).toContain("@a1!");
    expect(out).not.toContain("```idea");
    expect(out).not.toContain("rel: supersedes");
  });

  it("carries the ref but NO «IDEA» marker token (would be re-extracted)", () => {
    const out = framePrompt("Use a CRDT store", "challenge", "a1");
    expect(out).toContain("@a1!");
    expect(out).not.toContain("«IDEA");
    expect(out).not.toContain("<<IDEA");
  });

  it("keeps the editable-cursor invariant (trailing space, no newline)", () => {
    const out = framePrompt("S", "challenge", "a2");
    expect(out.endsWith(" ")).toBe(true);
    expect(out.endsWith("\n")).toBe(false);
  });

  it("the directive leads; the selection + open clause still follow", () => {
    const out = framePrompt("Use a CRDT store", "challenge", "a1");
    expect(out.indexOf("@a1!")).toBeLessThan(out.indexOf("Use a CRDT store"));
  });

  it("does NOT emit the supersede directive without a source ref", () => {
    const out = framePrompt("Use a CRDT store", "challenge");
    expect(out).not.toContain("@a1!");
    expect(out).not.toContain("«IDEA");
  });
});

describe("framePrompt — combine merge verb (#62, PD-019)", () => {
  it("chains every source ref with a trailing ! so the merge supersedes them all", () => {
    const out = framePrompt("A\n\nB\n\nC", "combine", ["a1", "a2", "a3"]);
    // The merged idea replaces each source via the chained `@aN!` form.
    expect(out).toContain("@a1!@a2!@a3!");
    // Each source is also named in the human-readable list.
    expect(out).toContain("@a1, @a2, @a3");
  });

  it("accepts a single ref as a bare string too (uniform with the other verbs)", () => {
    const arr = framePrompt("S", "combine", ["a1"]);
    const str = framePrompt("S", "combine", "a1");
    expect(arr).toBe(str);
    expect(arr).toContain("@a1!");
  });

  it("keeps the editable-cursor invariant (trailing space, no newline)", () => {
    const out = framePrompt("A\n\nB", "combine", ["a1", "a2"]);
    expect(out.endsWith(" ")).toBe(true);
    expect(out.endsWith("\n")).toBe(false);
  });

  it("the directive leads; the selection + open clause still follow", () => {
    const out = framePrompt("A\n\nB", "combine", ["a1", "a2"]);
    expect(out.indexOf("@a1!@a2!")).toBeLessThan(out.indexOf("What matters most"));
  });

  it("carries the refs but NO «IDEA» marker token (would be re-extracted)", () => {
    const out = framePrompt("A\n\nB", "combine", ["a1", "a2"]);
    expect(out).not.toContain("«IDEA");
    expect(out).not.toContain("<<IDEA");
  });

  it("frames the merge prompt distinctly and still yields nothing when empty", () => {
    expect(framePrompt("A", "combine")).toContain("into ONE stronger");
    expect(framePrompt("   ", "combine", ["a1", "a2"])).toBe("");
  });
});

describe("PROMPT_TEMPLATES", () => {
  const intents: PromptIntent[] = ["discuss", "expand", "challenge", "find-risks", "combine"];

  it("has an entry per intent that honours the trailing-space-no-newline invariant", () => {
    for (const intent of intents) {
      const out = PROMPT_TEMPLATES[intent]("a selection");
      expect(out).toContain("a selection");
      expect(out.endsWith(" ")).toBe(true);
      expect(out.endsWith("\n")).toBe(false);
    }
  });

  it("discuss frames with the expected scaffold", () => {
    expect(PROMPT_TEMPLATES.discuss("S")).toBe("Regarding these notes from the canvas:\n\nS\n\nLet's discuss: ");
  });
});

describe("frameReference (#194)", () => {
  const card = (over: Partial<ReferencedIdea> = {}): ReferencedIdea => ({
    ref: "a1",
    kind: "feature",
    title: "Offline sync",
    body: "Cache CRDT ops offline",
    ...over
  });

  it('returns "" for an empty selection', () => {
    expect(frameReference([])).toBe("");
  });

  it('returns "" when every card frames to nothing', () => {
    expect(frameReference([card({ ref: null, kind: "", title: "   ", body: "  " })])).toBe("");
  });

  it("leads each card with its @ref, kind tag, and title, body on the next lines", () => {
    const out = frameReference([card()]);
    expect(out).toContain("Referenced canvas ideas:");
    expect(out).toContain("@a1 [feature] Offline sync\nCache CRDT ops offline");
  });

  it("references every selected card, each with its own ref", () => {
    const out = frameReference([card(), card({ ref: "a2", kind: "risk", title: "Conflict resolution", body: "" })]);
    expect(out).toContain("@a1 [feature] Offline sync");
    expect(out).toContain("@a2 [risk] Conflict resolution");
  });

  it("carries NO preset verb — only the neutral refs hint follows the cards", () => {
    const out = frameReference([card()]);
    expect(out).toContain("Use the refs above (like @a1) when discussing these ideas.");
    // None of the verb scaffolds leak in.
    expect(out).not.toMatch(/Let's discuss|Expand on|stress-test|into ONE stronger/);
  });

  it("keeps the editable-cursor invariant (trailing space, no trailing newline)", () => {
    const out = frameReference([card()]);
    expect(out.endsWith(" ")).toBe(true);
    expect(out.endsWith("\n")).toBe(false);
    expect(out.endsWith("\n ")).toBe(false);
  });

  it("never embeds a literal marker token (echo safety, PD-008)", () => {
    const out = frameReference([card({ title: "Marker safety" })]);
    expect(out).not.toContain("«IDEA");
    expect(out).not.toContain("«SCORE");
    expect(out).not.toContain("<<IDEA");
  });

  it("annotates marked/done/superseded/scored cards compactly", () => {
    const out = frameReference([
      card({ starred: true, done: true, superseded: true, score: { impact: 5, effort: 2, confidence: 4 } })
    ]);
    expect(out).toContain("★ marked");
    expect(out).toContain("✓ done");
    expect(out).toContain("superseded");
    expect(out).toContain("impact 5/5 · effort 2/5");
  });

  it("tolerates a missing ref and an unknown kind (still references the card)", () => {
    const out = frameReference([card({ ref: null, kind: "" })]);
    expect(out).toContain("Offline sync");
    expect(out).not.toContain("@");
    // No ref anywhere → the refs hint drops its example.
    expect(out).toContain("Use the refs above when discussing these ideas.");
  });
});

describe("frameTriage (#60)", () => {
  it('returns "" for an empty board', () => {
    expect(frameTriage("")).toBe("");
    expect(frameTriage("   \n  ")).toBe("");
  });

  it("embeds the board and asks for impact/effort/confidence", () => {
    const prompt = frameTriage("@a1 [feature] Offline canvas — cache ops");
    expect(prompt).toContain("@a1 [feature] Offline canvas — cache ops");
    expect(prompt).toMatch(/impact.*effort.*confidence/i);
    expect(prompt).toContain("@ref");
  });

  it("never embeds a literal score/idea marker token (echo safety, PD-008)", () => {
    const prompt = frameTriage("@a1 thing");
    expect(prompt).not.toContain("«SCORE");
    expect(prompt).not.toContain("«IDEA");
  });
});

describe("frameSpec (#89, formats #110)", () => {
  const FORMATS = Object.keys(SPEC_FORMATS) as SpecFormat[];
  const board = "### ✨ Feature: Offline canvas\n\ncache CRDT ops";

  it('returns "" for an empty board in every format', () => {
    for (const format of FORMATS) {
      expect(frameSpec("", format)).toBe("");
      expect(frameSpec("   \n  ", format)).toBe("");
    }
  });

  it("embeds the board (trimmed) in every format", () => {
    for (const format of FORMATS) {
      expect(frameSpec(`\n  ${board}  \n`, format)).toContain(board);
    }
  });

  it("defaults to the PRD format (original #89 contract)", () => {
    expect(frameSpec(board)).toBe(frameSpec(board, "prd"));
  });

  it("applies the shared rules — grounding and ★ keep-marks — in every format (#59)", () => {
    for (const format of FORMATS) {
      const prompt = frameSpec("### ★ ✨ Feature: Pinned", format);
      expect(prompt).toContain("do not invent scope");
      expect(prompt).toContain("★");
      expect(prompt).toMatch(/GitHub-flavored markdown/i);
    }
  });

  it("prd: asks for the PRD sections, without an implementation plan section", () => {
    const prompt = frameSpec(board, "prd");
    expect(prompt).toContain("PRD");
    for (const section of ["Overview", "Goals", "Non-goals", "Requirements", "Open questions"]) {
      expect(prompt).toContain(section);
    }
    expect(prompt).not.toMatch(/implementation plan/i);
  });

  it("plan: asks for milestones, acceptance criteria, risks, and a testing strategy", () => {
    const prompt = frameSpec(board, "plan");
    expect(prompt).toMatch(/implementation plan/i);
    expect(prompt).toContain("milestones");
    expect(prompt).toContain("acceptance criteria");
    expect(prompt).toMatch(/risks/i);
    expect(prompt).toMatch(/testing strategy/i);
  });

  it("issues (default): asks for ready-to-file drafts and forbids creating them", () => {
    const prompt = frameSpec(board, "issues");
    expect(prompt).toContain("GitHub issues");
    expect(prompt).toContain("##");
    expect(prompt).toContain("labels");
    expect(prompt).toMatch(/do\s+NOT create/);
    expect(prompt).not.toContain("gh issue create");
  });

  it("issues with createIssues: instructs `gh issue create`, a created summary, and a drafts fallback", () => {
    const prompt = frameSpec(board, "issues", { createIssues: true });
    expect(prompt).toContain("gh issue create");
    expect(prompt).toMatch(/summary of what was created/i);
    expect(prompt).toContain("URL");
    expect(prompt).toMatch(/unavailable or unauthorized/i);
    expect(prompt).toMatch(/fall back/i);
  });

  it("tasks: asks for self-contained, copy-pasteable task prompts with acceptance criteria", () => {
    const prompt = frameSpec(board, "tasks");
    expect(prompt).toContain("self-contained");
    expect(prompt).toMatch(/copy-pasteable/i);
    expect(prompt).toContain("acceptance criteria");
  });

  it("SPEC_FORMATS descriptors carry a label, description, and file suffix per format", () => {
    for (const format of FORMATS) {
      const { label, description, fileSuffix } = SPEC_FORMATS[format];
      expect(label.length).toBeGreaterThan(0);
      expect(description.length).toBeGreaterThan(0);
      expect(fileSuffix).toMatch(/^[a-z]+$/);
    }
  });
});
