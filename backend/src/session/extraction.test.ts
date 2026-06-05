/**
 * Unit tests for the response extractor (design §4.3) against recorded
 * `capture-pane` fixtures: idle → echo → response → idle cycles, spinners,
 * multiline output, and scrollback. This is where the real risk lives, so it
 * is tested in isolation from tmux/node-pty (design §8 step 4).
 */

import { describe, it, expect } from "vitest";
import { ResponseExtractor, getProfile, DEFAULT_PROFILE } from "./extraction.ts";

/** Build a capture string from screen lines (as `capture-pane -p` would emit). */
const cap = (...lines: string[]): string => lines.join("\n");

const PYTHON = getProfile("python");

describe("ResponseExtractor — idle/echo/response/idle cycle (§4.4 spike)", () => {
  it("emits the response, skipping the echoed input and the prompt chrome", () => {
    const ex = new ResponseExtractor(PYTHON);

    // Capture 1: idle, just the banner + prompt.
    expect(ex.ingest(cap('Python 3.14.2 on linux', 'Type "help" for more.', ">>>")))
      .toEqual({ lines: [], complete: false });

    // User sends `print("hello")`.
    ex.beginResponse('print("hello")');
    expect(ex.responding).toBe(true);

    // Capture 2: echo + first response line, prompt has NOT returned yet.
    // The last line is held back (it may still be growing).
    expect(
      ex.ingest(cap('Python 3.14.2 on linux', 'Type "help" for more.', '>>> print("hello")', "hello")),
    ).toEqual({ lines: [], complete: false });

    // Capture 3: idle prompt reappears ⇒ complete; "hello" is now emitted.
    expect(
      ex.ingest(
        cap('Python 3.14.2 on linux', 'Type "help" for more.', '>>> print("hello")', "hello", ">>>"),
      ),
    ).toEqual({ lines: ["hello"], complete: true });

    expect(ex.responding).toBe(false);
  });

  it("never emits the echoed user input as a response line", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("1 + 1");
    const out = ex.ingest(cap(">>> 1 + 1", "2", ">>>"));
    expect(out).toEqual({ lines: ["2"], complete: true });
    expect(out.lines).not.toContain("1 + 1");
  });
});

describe("ResponseExtractor — multiline + incremental emission", () => {
  it("emits a multi-line response in stable increments, last line on complete", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("go()");

    // Only line one present so far — held back as the growing tail.
    expect(ex.ingest(cap(">>> go()", "line one"))).toEqual({ lines: [], complete: false });
    // line two arrives — line one is now stable and emitted.
    expect(ex.ingest(cap(">>> go()", "line one", "line two"))).toEqual({
      lines: ["line one"],
      complete: false,
    });
    // Prompt returns — flush the remainder and mark complete.
    expect(ex.ingest(cap(">>> go()", "line one", "line two", ">>>"))).toEqual({
      lines: ["line two"],
      complete: true,
    });
  });

  it("handles a whole multi-line block that completes in one capture", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("dump()");
    expect(ex.ingest(cap(">>> dump()", "alpha", "beta", "gamma", ">>>"))).toEqual({
      lines: ["alpha", "beta", "gamma"],
      complete: true,
    });
  });
});

describe("ResponseExtractor — chrome filtering", () => {
  it("drops braille spinner / 'thinking' status lines but keeps real content", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("work()");
    const out = ex.ingest(cap(">>> work()", "⠋ thinking…", "result ready", ">>>"));
    expect(out).toEqual({ lines: ["result ready"], complete: true });
  });

  it("preserves markdown bullets and dividers (not mistaken for chrome)", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("md()");
    const out = ex.ingest(cap(">>> md()", "- bullet one", "- bullet two", "---", ">>>"));
    expect(out).toEqual({ lines: ["- bullet one", "- bullet two", "---"], complete: true });
  });
});

describe("ResponseExtractor — idle-timeout completion (no prompt marker)", () => {
  it("finalize() flushes the held-back tail and completes", () => {
    const ex = new ResponseExtractor(getProfile("bash"));
    ex.ingest(cap("user@host:~$"));
    ex.beginResponse("echo hi");
    // bash's PS1 is not anchored, so the prompt return is not detected; the
    // last line stays held back until the idle timeout fires.
    expect(ex.ingest(cap("user@host:~$ echo hi", "hi"))).toEqual({ lines: [], complete: false });
    // Poller observes the pane went quiet → finalize.
    expect(ex.finalize()).toEqual({ lines: ["hi"], complete: true });
    expect(ex.responding).toBe(false);
  });

  it("finalize() is a no-op when not responding", () => {
    const ex = new ResponseExtractor(PYTHON);
    expect(ex.finalize()).toEqual({ lines: [], complete: false });
  });
});

describe("ResponseExtractor — scrollback / multiple cycles", () => {
  it("anchors on the MOST RECENT echo when prior cycles remain in scrollback", () => {
    const ex = new ResponseExtractor(PYTHON);
    // First cycle already in the captured scrollback.
    ex.ingest(cap(">>> first()", "first-out", ">>>"));
    // Second prompt sent — its echo and output appear below the first cycle.
    ex.beginResponse("second()");
    const out = ex.ingest(
      cap(">>> first()", "first-out", ">>> second()", "second-out", ">>>"),
    );
    expect(out).toEqual({ lines: ["second-out"], complete: true });
    expect(out.lines).not.toContain("first-out");
  });

  it("does not emit anything while idle between responses", () => {
    const ex = new ResponseExtractor(PYTHON);
    expect(ex.ingest(cap("banner", ">>>"))).toEqual({ lines: [], complete: false });
    expect(ex.ingest(cap("banner", ">>>"))).toEqual({ lines: [], complete: false });
  });
});

describe("ResponseExtractor — multiline input echo", () => {
  it("skips all echoed lines of a multi-line prompt", () => {
    const ex = new ResponseExtractor(PYTHON);
    ex.ingest(cap(">>>"));
    ex.beginResponse("for i in range(2):\n    print(i)");
    // python echoes the block across a primary + continuation prompt.
    const out = ex.ingest(
      cap(">>> for i in range(2):", "...     print(i)", "0", "1", ">>>"),
    );
    expect(out).toEqual({ lines: ["0", "1"], complete: true });
  });
});

describe("getProfile", () => {
  it("returns the default profile for an unknown name and warns", () => {
    const warnings: string[] = [];
    const profile = getProfile("nonsense-harness", (m) => warnings.push(m));
    expect(profile).toBe(DEFAULT_PROFILE);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/nonsense-harness/);
  });

  it("returns the default profile (no warning) when no name is given", () => {
    const warnings: string[] = [];
    expect(getProfile(undefined, (m) => warnings.push(m))).toBe(DEFAULT_PROFILE);
    expect(warnings.length).toBe(0);
  });
});
