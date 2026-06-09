import { describe, it, expect } from "vitest";
import { tokenizeCommand, hasFlag } from "./resolve.ts";

describe("tokenizeCommand", () => {
  it("returns an empty list for blank input", () => {
    expect(tokenizeCommand("")).toEqual([]);
    expect(tokenizeCommand("   ")).toEqual([]);
  });

  it("splits a bare binary from its inline args", () => {
    expect(tokenizeCommand("claude --model=opus")).toEqual(["claude", "--model=opus"]);
    expect(tokenizeCommand("pi --model gpt-4o")).toEqual(["pi", "--model", "gpt-4o"]);
  });

  it("collapses runs of whitespace", () => {
    expect(tokenizeCommand("  claude    --model=opus ")).toEqual(["claude", "--model=opus"]);
  });

  it("keeps a quoted path with spaces as one token", () => {
    expect(tokenizeCommand('"C:\\Program Files\\x\\pi.exe" --model gpt-4o')).toEqual([
      "C:\\Program Files\\x\\pi.exe",
      "--model",
      "gpt-4o",
    ]);
    expect(tokenizeCommand("'/opt/my tools/claude' --foo")).toEqual(["/opt/my tools/claude", "--foo"]);
  });
});

describe("hasFlag", () => {
  it("matches the separate form (--model x)", () => {
    expect(hasFlag(["--model", "opus"], "--model")).toBe(true);
  });

  it("matches the combined form (--model=x)", () => {
    expect(hasFlag(["--model=opus"], "--model")).toBe(true);
  });

  it("is false when the flag is absent", () => {
    expect(hasFlag(["--foo", "--modeling"], "--model")).toBe(false);
    expect(hasFlag([], "--model")).toBe(false);
  });
});
