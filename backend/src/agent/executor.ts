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
 * Resource limits (#142): every run is bounded by a wall-clock timeout, a
 * total-output cap, and (on Linux, via prlimit) CPU-seconds and optionally
 * address space. A kill always targets the process TREE — on Windows the
 * direct child is usually just the `cmd.exe` shim wrapper, and on POSIX the
 * child is spawned in its own process group so the group can be signalled.
 * See docs/security/agent-executor-hardening.md for the threat model.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { AgentArtifact, AgentCapability, AgentStatusMessage, SpecFormat } from "@ai-storm/shared";
import { resolveLaunch, type ResolvedLaunch } from "../pty/resolve.ts";
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

export interface AgentLimits {
  /** Wall-clock ceiling per run; the tree is killed when it expires. */
  timeoutMs: number;
  /** Max stdin payload accepted from the client; larger runs are refused. */
  maxPayloadBytes: number;
  /** Max stdout retained for post-exit artifact parsing (#120). */
  maxCaptureBytes: number;
  /** Max combined stdout+stderr streamed before the run is killed. */
  maxOutputBytes: number;
  /** Linux prlimit --cpu (seconds); 0 disables. */
  maxCpuSeconds: number;
  /** Linux prlimit --as (MB); 0 (default) disables — V8-based harnesses
   *  reserve large virtual address ranges, so this is opt-in. */
  maxMemoryMb: number;
}

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback;
}

/** Read per run (not at module load) so ops/tests can tune via env. */
export function agentLimits(): AgentLimits {
  return {
    timeoutMs: envInt("AI_STORM_AGENT_TIMEOUT_MS", 10 * 60_000),
    maxPayloadBytes: envInt("AI_STORM_AGENT_MAX_PAYLOAD_BYTES", 2 * 1024 * 1024),
    maxCaptureBytes: envInt("AI_STORM_AGENT_MAX_CAPTURE_BYTES", 2 * 1024 * 1024),
    maxOutputBytes: envInt("AI_STORM_AGENT_MAX_OUTPUT_BYTES", 16 * 1024 * 1024),
    maxCpuSeconds: envInt("AI_STORM_AGENT_MAX_CPU_SECONDS", 900),
    maxMemoryMb: envInt("AI_STORM_AGENT_MAX_MEMORY_MB", 0),
  };
}

// prlimit ships with util-linux (present on effectively every Linux distro);
// probed once. macOS has no prlimit and Windows would need Job Objects — both
// fall back to the wall-clock timeout + tree kill.
let prlimitAvailable: boolean | null = null;
function hasPrlimit(): boolean {
  if (prlimitAvailable === null) {
    try {
      prlimitAvailable = spawnSync("prlimit", ["--version"], { stdio: "ignore" }).status === 0;
    } catch {
      prlimitAvailable = false;
    }
  }
  return prlimitAvailable;
}

function withResourceLimits(launch: ResolvedLaunch, limits: AgentLimits): ResolvedLaunch {
  if (process.platform !== "linux" || !hasPrlimit()) return launch;
  const flags: string[] = [];
  if (limits.maxCpuSeconds > 0) flags.push(`--cpu=${limits.maxCpuSeconds}`);
  if (limits.maxMemoryMb > 0) flags.push(`--as=${limits.maxMemoryMb * 1024 * 1024}`);
  if (flags.length === 0) return launch;
  return { cmd: "prlimit", args: [...flags, "--", launch.cmd, ...launch.args] };
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
): ChildProcess | null {
  const limits = agentLimits();

  // The payload is buffered into the child's stdin pipe in one piece; refuse
  // pathological sizes before allocating anything (#142).
  const payloadBytes = Buffer.byteLength(spec.payload, "utf8");
  if (payloadBytes > limits.maxPayloadBytes) {
    log.warn("agent.payload_too_large", { workspace: workspaceId, bytes: payloadBytes, cap: limits.maxPayloadBytes });
    emit({
      workspaceId,
      status: "error",
      data: `Agent payload too large (${payloadBytes} bytes; limit ${limits.maxPayloadBytes}).`,
    });
    return null;
  }

  // Only the static, trusted args reach the command line; the untrusted payload
  // is piped to stdin below (see module header). Requested capabilities append
  // backend-owned flags from the vetted table (#120) — never client strings.
  const caps = resolveCapabilities(spec.command, spec.capabilities);
  const requestedArgs = [...(spec.args ?? []), ...caps.args];
  for (const cap of caps.rejected) {
    log.warn("agent.capability_rejected", { workspace: workspaceId, command: spec.command, capability: cap });
    emit({
      workspaceId,
      status: "stderr",
      data: `[ai-storm] Ignored requested capability "${cap}": no vetted permission mapping for command "${spec.command}".\n`,
    });
  }
  const grantedCreateIssues = spec.capabilities?.includes("create-issues") === true && caps.rejected.length === 0;

  let launch;
  try {
    launch = withResourceLimits(resolveLaunch(spec.command, requestedArgs), limits);
  } catch (err) {
    log.error("agent.resolve_failed", {
      workspace: workspaceId,
      command: spec.command,
      error: err instanceof Error ? err.message : String(err),
    });
    emit({ workspaceId, status: "error", data: (err instanceof Error ? err.message : String(err)) });
    return null;
  }

  const child = spawn(launch.cmd, launch.args, {
    cwd: spec.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    // Own process group on POSIX so a kill can signal the whole tree.
    detached: process.platform !== "win32",
  });

  child.on("error", (err) => {
    log.error("agent.spawn_failed", { workspace: workspaceId, command: spec.command, error: err.message });
    emit({ workspaceId, status: "error", data: `Failed to spawn "${spec.command}": ${err.message}` });
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
      format: spec.format ?? "",
    });
    emit({ workspaceId, status: "spawned", pid: child.pid ?? -1, format: spec.format });
  });

  // Wall-clock ceiling (#142): a hung or runaway harness must not live forever
  // just because the WebSocket stays open. unref'd so it never pins the server.
  let killedFor: "timeout" | "output-cap" | null = null;
  const timer = setTimeout(() => {
    killedFor = "timeout";
    log.warn("agent.timeout", { workspace: workspaceId, command: spec.command, timeoutMs: limits.timeoutMs });
    emit({
      workspaceId,
      status: "stderr",
      data: `[ai-storm] Agent run exceeded the ${Math.round(limits.timeoutMs / 1000)}s time limit; killing it.\n`,
    });
    killAgentTree(child);
  }, limits.timeoutMs);
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
    if (outputBytes > limits.maxOutputBytes && killedFor === null) {
      killedFor = "output-cap";
      log.warn("agent.output_capped", { workspace: workspaceId, command: spec.command, cap: limits.maxOutputBytes });
      emit({
        workspaceId,
        status: "stderr",
        data: `[ai-storm] Agent run exceeded the ${limits.maxOutputBytes}-byte output limit; killing it.\n`,
      });
      killAgentTree(child);
    }
  };

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    // Cap the artifact buffer independently of streaming: parsing works on a
    // truncated head, while an unbounded string would mirror the whole run.
    if (captureArtifacts && captured.length < limits.maxCaptureBytes) captured += d;
    emit({ workspaceId, status: "stdout", data: d });
    noteOutput(d);
  });
  child.stderr?.on("data", (d: string) => {
    emit({ workspaceId, status: "stderr", data: d });
    noteOutput(d);
  });

  child.on("close", (code) => {
    clearTimeout(timer);
    log.info("agent.exit", { workspace: workspaceId, command: spec.command, code: code ?? -1, killedFor: killedFor ?? "" });
    if (captureArtifacts) {
      const artifacts = parseIssueArtifacts(captured);
      if (artifacts.length > 0) emitArtifacts(artifacts);
    }
    emit({ workspaceId, status: "exit", code: code ?? -1 });
  });

  return child;
}
