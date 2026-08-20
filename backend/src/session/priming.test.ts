import { describe, expect, it } from "vitest";
import { harnessSetup } from "./priming.ts";

const CURRENT_PROJECT_ID = "collaboration-board";

describe("MCP session priming — current project identity (#246)", () => {
  it.each(["claude", "codex", "pi"])("gives %s the route-bound current project id and selection rules", (command) => {
    const { harnessProfile, prime } = harnessSetup(command, CURRENT_PROJECT_ID);

    expect(harnessProfile).toBe(command);
    expect(prime).toContain(`this MCP session is structurally bound to project ID "${CURRENT_PROJECT_ID}"`);
    expect(prime).toContain(`pass exactly "${CURRENT_PROJECT_ID}" as projectId to get_board_ideas`);
    expect(prime).toContain("Never infer the current project from a title, folder, or runtime status");
    expect(prime).toContain(
      "Call get_projects only when the user explicitly asks to list projects or identify a different project"
    );
  });

  it.each([
    ["claude --model=opus", "claude"],
    ["codex --model=gpt-5.6-sol", "codex"],
    ["pi --model openai/gpt-5.4", "pi"],
    ["'/opt/AI tools/claude' --model=opus", "claude"]
  ])("profiles an inline harness command %s from its executable", (command, expectedProfile) => {
    const { harnessProfile, prime } = harnessSetup(command, CURRENT_PROJECT_ID);

    expect(harnessProfile).toBe(expectedProfile);
    expect(prime).toContain("call the capture_idea tool");
    expect(prime).toContain(`this MCP session is structurally bound to project ID "${CURRENT_PROJECT_ID}"`);
    expect(prime).not.toContain("«IDEA» <short title>");
  });

  it("does not prime a non-contract shell with project routing instructions", () => {
    expect(harnessSetup("bash", CURRENT_PROJECT_ID)).toEqual({
      harnessProfile: undefined,
      prime: undefined
    });
  });
});
