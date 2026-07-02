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

export function runAgent(
  workspaceId: string,
  spec: AgentSpec,
  emit: AgentEmitter,
  emitArtifacts?: ArtifactEmitter,
): ChildProcess | null {
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
    launch = resolveLaunch(spec.command, requestedArgs);
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

  // Captured stdout for post-exit artifact parsing (#120) — only buffered when
  // this run can actually produce artifacts (issues format + granted create).
  const captureArtifacts = spec.format === "issues" && grantedCreateIssues && emitArtifacts != null;
  let captured = "";

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => {
    if (captureArtifacts) captured += d;
    emit({ workspaceId, status: "stdout", data: d });
  });
  child.stderr?.on("data", (d: string) => emit({ workspaceId, status: "stderr", data: d }));

  child.on("close", (code) => {
    log.info("agent.exit", { workspace: workspaceId, command: spec.command, code: code ?? -1 });
    if (captureArtifacts) {
      const artifacts = parseIssueArtifacts(captured);
      if (artifacts.length > 0) emitArtifacts(artifacts);
    }
    emit({ workspaceId, status: "exit", code: code ?? -1 });
  });

  return child;
}
