import { describe, it, expect } from "vitest";
import { resolveCapabilities } from "./capabilities.ts";

describe("resolveCapabilities (#120)", () => {
  it("returns nothing for no requested capabilities", () => {
    expect(resolveCapabilities("claude", undefined)).toEqual({ args: [], rejected: [] });
    expect(resolveCapabilities("claude", [])).toEqual({ args: [], rejected: [] });
  });

  it("maps create-issues to the vetted flag for claude", () => {
    expect(resolveCapabilities("claude", ["create-issues"])).toEqual({
      args: ["--allowedTools", "Bash(gh issue create:*)"],
      rejected: []
    });
  });

  it("recognizes the command through paths, extensions, case, and inline flags", () => {
    for (const command of [
      "Claude",
      "claude --model=opus",
      "C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd",
      "/usr/local/bin/claude",
      "claude.exe"
    ]) {
      expect(resolveCapabilities(command, ["create-issues"]).args).toEqual([
        "--allowedTools",
        "Bash(gh issue create:*)"
      ]);
    }
  });

  it("rejects the capability for an unrecognized command instead of widening", () => {
    expect(resolveCapabilities("aider", ["create-issues"])).toEqual({
      args: [],
      rejected: ["create-issues"]
    });
  });

  it("rejects an unknown capability name from the wire", () => {
    // Wire data is untrusted — an unknown name must land in `rejected`.
    const res = resolveCapabilities("claude", ["do-anything" as never]);
    expect(res.args).toEqual([]);
    expect(res.rejected).toEqual(["do-anything"]);
  });
});
