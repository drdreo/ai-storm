/**
 * Downstream agent execution hook (PRD §3.6).
 *
 * When the user triggers the contextual macro on a block selection, the client
 * sends an `agent` message. The backend spawns an asynchronous local subprocess
 * invoking the orchestrator command, and streams the subprocess lifecycle back
 * to the client. Runs detached from any PTY (one-shot, captured stdio).
 *
 * The extracted plain-text payload (untrusted, canvas/terminal-derived, and
 * potentially large) is delivered to the harness on **stdin**, NOT on the
 * command line. On Windows `claude` is typically a `.cmd` shim wrapped via
 * `cmd.exe /c`, so placing the payload on argv would let cmd.exe re-parse it
 * (CVE-2024-27980-class injection) and could exceed the ~32 KB command-line
 * limit. Only the static, trusted `spec.args` reach argv.
 *
 * Bounds (#142, PD-022): a run is capped by a wall-clock timeout (server
 * config, tree-killed on expiry) and an output circuit-breaker, and its whole
 * process TREE is killed — on Windows the direct child is usually just the
 * `cmd.exe` shim wrapper, on POSIX the child gets its own process group so the
 * group can be signalled. Sized for a local single-user tool, not a host:
 * hard CPU/memory caps (prlimit/Job Objects) are deliberately not attempted.
 * See docs/security/agent-executor-hardening.md for the threat model.
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { AgentArtifact, AgentCapability, AgentStatusMessage, SpecFormat } from "@ai-storm/shared";
import { resolveLaunch } from "../pty/resolve.ts";
import { resolveCapabilities } from "./capabilities.ts";
import { parseIssueArtifacts } from "./artifacts.ts";
import { log } from "../log.ts";

export type AgentEmitter = (msg: Omit<AgentStatusMessage, "type">) => void;
export type ArtifactEmitter = (artifacts: AgentArtifact[]) => void;

export interface AgentSpec {
  command: string;
  args?: string[];
  payload: string;
  cwd?: string;
  /** Hand-off format metadata (#120) — echoed on `spawned`, keyed into logs. */
  format?: SpecFormat;
  /** Named per-run capabilities to resolve via the vetted table (#120). */
  capabilities?: AgentCapability[];
}

export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60_000;

/**
 * Circuit-breaker caps (#142, PD-022) — not exact quotas. ai-storm is a local
 * single-user tool (PD-003): these exist so a runaway harness cannot take the
 * machine down, not to meter a hostile tenant. Accounting is per-chunk in
 * UTF-16 code units, the chunk that crosses a cap still streams, and overshoot
 * is bounded by the pipe buffer — byte-exactness would buy nothing here. Sized
 * generously and NOT env-tunable; the one knob a user may legitimately raise is
 * the timeout, which is real server config (`--agent-timeout-ms`).
 */
export const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Per-run behaviour owned by SERVER configuration (never the client). */
export interface AgentRunOptions {
  /** Wall-clock ceiling per run; the process tree is killed when it expires.
   *  Server config (`--agent-timeout-ms`, PD-022) — the one bound a user may
   *  legitimately raise for long side-effecting runs. */
  timeoutMs?: number;
  /** Circuit-breaker overrides; only tests set these — the server uses the
   *  module defaults above. Kept off env/CLI to avoid permanent knob surface. */
  maxPayloadBytes?: number;
  maxOutputBytes?: number;
}

/**
 * Kill an agent run's whole process tree. `child.kill()` alone is not enough:
 * on Windows the direct child is typically the `cmd.exe` shim wrapper (killing
 * it strands the actual harness), and on POSIX the harness may have forked.
 */
export function killAgentTree(child: ChildProcess): void {
  if (child.pid == null || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    } catch {
      // taskkill missing or the process already exited; nothing more to do.
    }
    return;
  }
  // Spawned detached => own process group; negative pid signals the group.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // already exited
    }
  }
}

export function runAgent(
  workspaceId: string,
  spec: AgentSpec,
  emit: AgentEmitter,
  emitArtifacts?: ArtifactEmitter,
  opts?: AgentRunOptions
): ChildProcess | null {
  const timeoutMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const maxPayloadBytes = opts?.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
  const maxOutputBytes = opts?.maxOutputBytes ?? MAX_OUTPUT_BYTES;

  // The payload is buffered into the child's stdin pipe in one piece; refuse
  // pathological sizes before allocating anything (#142).
  const payloadBytes = Buffer.byteLength(spec.payload, "utf8");
  if (payloadBytes > maxPayloadBytes) {
    log.warn("agent.payload_too_large", { workspace: workspaceId, bytes: payloadBytes, cap: maxPayloadBytes });
    emit({
      workspaceId,
      status: "error",
      data: `Agent payload too large (${payloadBytes} bytes; limit ${maxPayloadBytes}).`
    });
    return null;
  }

  // Only the static, trusted args reach the command line; the untrusted payload
  // is piped to stdin below (see module header). Requested capabilities append
  // backend-owned flags from the vetted table (#120) — never client strings.
  const caps = resolveCapabilities(spec.command, spec.capabilities);
  const requestedArgs = [...(spec.args ?? []), ...caps.args];
  for (const cap of caps.rejected) {
    log.warn("agent.capability_rejected", {
      workspace: workspaceId,
      command: spec.command,
      capability: cap
    });
    emit({
      workspaceId,
      status: "stderr",
      data: `[ai-storm] Ignored requested capability "${cap}": no vetted permission mapping for command "${spec.command}".\n`
    });
  }
  const grantedCreateIssues = spec.capabilities?.includes("create-issues") === true && caps.rejected.length === 0;

  let launch;
  try {
    // Strict validation is right for THIS path only: agent-run args are short
    // static flags, so control chars / cmd metachars are never legitimate.
    // (PTY sessions resolve non-strict — their argv carries the multi-line
    // prime and quoted MCP JSON.)
    launch = resolveLaunch(spec.command, requestedArgs, { strict: true });
  } catch (err) {
    log.error("agent.resolve_failed", {
      workspace: workspaceId,
      command: spec.command,
      error: err instanceof Error ? err.message : String(err)
    });
    emit({ workspaceId, status: "error", data: err instanceof Error ? err.message : String(err) });
    return null;
  }

  const child = spawn(launch.cmd, launch.args, {
    cwd: spec.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // Own process group on POSIX so a kill can signal the whole tree.
    detached: process.platform !== "win32"
  });

  child.on("error", (err) => {
    log.error("agent.spawn_failed", {
      workspace: workspaceId,
      command: spec.command,
      error: err.message
    });
    emit({
      workspaceId,
      status: "error",
      data: `Failed to spawn "${spec.command}": ${err.message}`
    });
  });

  // Deliver the untrusted payload on stdin, then close it so the one-shot
  // harness sees EOF. Guard against the stream erroring if spawn failed.
  if (child.stdin) {
    child.stdin.on("error", () => {
      // child never started or closed stdin early; spawn 'error' handler reports it.
    });
    child.stdin.end(spec.payload);
  }

  child.on("spawn", () => {
    log.info("agent.spawned", {
      workspace: workspaceId,
      command: spec.command,
      pid: child.pid ?? -1,
      format: spec.format ?? ""
    });
    emit({ workspaceId, status: "spawned", pid: child.pid ?? -1, format: spec.format });
  });

  // Wall-clock ceiling (#142): a hung or runaway harness must not live forever
  // just because the WebSocket stays open. unref'd so it never pins the server.
  let killedFor: "timeout" | "output-cap" | null = null;
  const timer = setTimeout(() => {
    killedFor = "timeout";
    log.warn("agent.timeout", { workspace: workspaceId, command: spec.command, timeoutMs });
    emit({
      workspaceId,
      status: "stderr",
      data:
        `[ai-storm] Agent run exceeded the ${Math.round(timeoutMs / 1000)}s time limit; killing it. ` +
        `(Raise it with --agent-timeout-ms.)\n`
    });
    killAgentTree(child);
  }, timeoutMs);
  timer.unref();

  // Captured stdout for post-exit artifact parsing (#120) — only buffered when
  // this run can actually produce artifacts (issues format + granted create).
  const captureArtifacts = spec.format === "issues" && grantedCreateIssues && emitArtifacts != null;
  let captured = "";
  let outputBytes = 0;

  // Total-output ceiling (#142): a harness spewing output would otherwise
  // flood the WebSocket (and the browser) unbounded until the timeout.
  const noteOutput = (chunk: string): void => {
    outputBytes += chunk.length;
    if (outputBytes > maxOutputBytes && killedFor === null) {
      killedFor = "output-cap";
      log.warn("agent.output_capped", { workspace: workspaceId, command: spec.command, cap: maxOutputBytes });
      emit({
        workspaceId,
        status: "stderr",
        data: `[ai-storm] Agent run exceeded the ${maxOutputBytes}-byte output limit; killing it.\n`
      });
      killAgentTree(child);
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    // Cap the artifact buffer independently of streaming: parsing works on a
    // truncated head, while an unbounded string would mirror the whole run.
    if (captureArtifacts && captured.length < MAX_CAPTURE_BYTES) {
      captured += d.slice(0, MAX_CAPTURE_BYTES - captured.length);
    }
    emit({ workspaceId, status: "stdout", data: d });
    noteOutput(d);
  });
  child.stderr?.on("data", (d: string) => {
    emit({ workspaceId, status: "stderr", data: d });
    noteOutput(d);
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    log.info("agent.exit", {
      workspace: workspaceId,
      command: spec.command,
      code: code ?? -1,
      killedFor: killedFor ?? ""
    });
    if (captureArtifacts) {
      const artifacts = parseIssueArtifacts(captured);
      if (artifacts.length > 0) emitArtifacts(artifacts);
    }
    emit({ workspaceId, status: "exit", code: code ?? -1 });
  });

  return child;
}
