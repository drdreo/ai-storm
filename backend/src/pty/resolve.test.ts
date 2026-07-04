import { describe, it, expect } from "vitest";
import { tokenizeCommand, hasFlag, assertNoControlCharacters, assertCmdSafeTokens, resolveLaunch } from "./resolve.ts";

describe("resolveLaunch strictness", () => {
  const NL = String.fromCharCode(10);
  const NUL = String.fromCharCode(0);

  it("non-strict accepts a multi-line prime arg (PTY session path — #142 regression)", () => {
    expect(() =>
      resolveLaunch("node", ["--append-system-prompt", "You are in a brainstorming project." + NL + "Rules:"])
    ).not.toThrow();
  });

  it("non-strict accepts quoted JSON args (--mcp-config)", () => {
    expect(() => resolveLaunch("node", ["--mcp-config", '{"mcpServers":{"x":{"type":"http"}}}'])).not.toThrow();
  });

  it("rejects NUL bytes even when non-strict", () => {
    expect(() => resolveLaunch("node", ["a" + NUL + "b"])).toThrow(/NUL/);
  });

  it("strict mode rejects control characters (agent-run path)", () => {
    expect(() => resolveLaunch("node", ["evil" + NL + "line"], { strict: true })).toThrow(/control characters/);
  });
});

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
      "gpt-4o"
    ]);
    expect(tokenizeCommand("'/opt/my tools/claude' --foo")).toEqual(["/opt/my tools/claude", "--foo"]);
  });
});

describe("assertNoControlCharacters", () => {
  it("accepts ordinary commands and flags", () => {
    expect(() =>
      assertNoControlCharacters("claude", ["--model=opus", "--allowedTools", "Bash(gh issue create:*)"])
    ).not.toThrow();
    expect(() => assertNoControlCharacters("C:\\Program Files\\x\\pi.exe", [])).not.toThrow();
  });

  it("rejects control characters in the command", () => {
    expect(() => assertNoControlCharacters("cla\tude", [])).toThrow(/control characters/);
    expect(() => assertNoControlCharacters("claude\u001b[31m", [])).toThrow(/control characters/);
  });

  it("rejects control characters in any argument", () => {
    expect(() => assertNoControlCharacters("claude", ["--ok", "evil\nline"])).toThrow(/control characters/);
    expect(() => assertNoControlCharacters("claude", ["a\rb"])).toThrow(/control characters/);
  });
});

describe("assertCmdSafeTokens", () => {
  it("accepts typical harness flags", () => {
    expect(() =>
      assertCmdSafeTokens("C:\\npm\\claude.cmd", ["--model=opus", "--allowedTools", "Bash(gh issue create:*)"])
    ).not.toThrow();
  });

  it("rejects cmd metacharacters in arguments (BatBadBut class)", () => {
    for (const bad of ["x&calc", "a|b", "a<b", "a>b", "a^b", '"quoted"', "%PATH%"]) {
      expect(() => assertCmdSafeTokens("C:\\npm\\claude.cmd", [bad])).toThrow(/cmd metacharacters/);
    }
  });

  it("rejects cmd metacharacters in the target path itself", () => {
    expect(() => assertCmdSafeTokens("C:\\evil&calc\\claude.cmd", [])).toThrow(/cmd metacharacters/);
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
