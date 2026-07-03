import { describe, it, expect, afterEach } from "vitest";
import type { AgentStatusMessage } from "@ai-storm/shared";
import { runAgent, agentLimits, type AgentRunOptions } from "./executor.ts";

type Status = Omit<AgentStatusMessage, "type">;

/** Run `node -e script` through the executor and collect emits until exit. */
function collectRun(script: string, payload = "", opts?: AgentRunOptions): Promise<Status[]> {
  return new Promise((resolve, reject) => {
    const emits: Status[] = [];
    const child = runAgent(
      "ws-test",
      { command: "node", args: ["-e", script], payload },
      (msg) => {
        emits.push(msg);
        if (msg.status === "exit") resolve(emits);
      },
      undefined,
      opts,
    );
    // A refused run (payload cap, resolve failure) never spawns: the error
    // emit has already happened synchronously.
    if (child === null) resolve(emits);
    setTimeout(() => reject(new Error("run did not finish in time")), 20_000).unref();
  });
}

const stdout = (emits: Status[]) =>
  emits.filter((e) => e.status === "stdout").map((e) => e.data).join("");
const stderr = (emits: Status[]) =>
  emits.filter((e) => e.status === "stderr").map((e) => e.data).join("");

const ENV_KEYS = ["AI_STORM_AGENT_MAX_PAYLOAD_BYTES", "AI_STORM_AGENT_MAX_OUTPUT_BYTES"] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("agentLimits", () => {
  it("has sane defaults and honors env overrides", () => {
    expect(agentLimits().maxOutputBytes).toBe(16 * 1024 * 1024);
    process.env.AI_STORM_AGENT_MAX_OUTPUT_BYTES = "1234";
    expect(agentLimits().maxOutputBytes).toBe(1234);
  });

  it("falls back on a non-numeric override", () => {
    process.env.AI_STORM_AGENT_MAX_OUTPUT_BYTES = "lots";
    expect(agentLimits().maxOutputBytes).toBe(16 * 1024 * 1024);
  });
});

describe("runAgent", () => {
  it("delivers the payload on stdin and streams stdout to exit", async () => {
    const emits = await collectRun("process.stdin.pipe(process.stdout)", "hello agent");
    expect(emits.some((e) => e.status === "spawned")).toBe(true);
    expect(stdout(emits)).toContain("hello agent");
    expect(emits.at(-1)).toMatchObject({ status: "exit", code: 0 });
  });

  it("refuses a payload over the size cap without spawning", async () => {
    process.env.AI_STORM_AGENT_MAX_PAYLOAD_BYTES = "8";
    const emits = await collectRun("", "way more than eight bytes");
    expect(emits).toHaveLength(1);
    expect(emits[0]).toMatchObject({ status: "error" });
    expect(emits[0].data).toMatch(/payload too large/i);
  });

  it("kills a run that exceeds the wall-clock timeout (server-config knob)", async () => {
    const emits = await collectRun("setInterval(() => {}, 1000)", "", { timeoutMs: 400 });
    expect(stderr(emits)).toMatch(/time limit/);
    expect(emits.at(-1)?.status).toBe("exit");
    expect(emits.at(-1)?.code).not.toBe(0);
  }, 20_000);

  it("kills a run that exceeds the output cap", async () => {
    process.env.AI_STORM_AGENT_MAX_OUTPUT_BYTES = "2048";
    const emits = await collectRun(
      'const s = "x".repeat(512); setInterval(() => process.stdout.write(s), 20);',
    );
    expect(stderr(emits)).toMatch(/output limit/);
    expect(emits.at(-1)?.status).toBe("exit");
  }, 20_000);

  it("reports failure for an unresolvable command", async () => {
    // The failure shape is platform-dependent: Windows fails synchronously in
    // resolveLaunch (where.exe miss, `error` status), bare POSIX gets a spawn
    // ENOENT (`error` then `exit`), and Linux-under-prlimit spawns prlimit
    // fine and sees it exit non-zero after failing to exec the target.
    const emits: Status[] = [];
    await new Promise<void>((resolve) => {
      const child = runAgent(
        "ws-test",
        { command: "definitely-not-a-real-binary-142", payload: "" },
        (msg) => {
          emits.push(msg);
          if (msg.status === "error" || msg.status === "exit") resolve();
        },
      );
      if (child === null) resolve();
    });
    const failed = emits.some((e) => e.status === "error" || (e.status === "exit" && e.code !== 0));
    expect(failed).toBe(true);
  });
});
