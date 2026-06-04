/**
 * Downstream agent execution hook (PRD §3.6).
 *
 * When the user triggers the contextual macro on a block selection, the client
 * sends an `agent` message. The backend spawns an asynchronous local subprocess
 * invoking the orchestrator command with the extracted plain text passed as a
 * functional argument, and streams the subprocess lifecycle back to the client.
 * Runs detached from any PTY (one-shot, captured stdio).
 */

import { spawn } from "node:child_process";
import type { AgentStatusMessage } from "../protocol.ts";
import { resolveLaunch } from "../pty/resolve.ts";
import { log } from "../log.ts";

export type AgentEmitter = (msg: Omit<AgentStatusMessage, "type">) => void;

export interface AgentSpec {
  command: string;
  args?: string[];
  payload: string;
  cwd?: string;
}

export function runAgent(workspaceId: string, spec: AgentSpec, emit: AgentEmitter): void {
  const requestedArgs = [...(spec.args ?? []), spec.payload];

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
    return;
  }

  const child = spawn(launch.cmd, launch.args, {
    cwd: spec.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.on("error", (err) => {
    log.error("agent.spawn_failed", { workspace: workspaceId, command: spec.command, error: err.message });
    emit({ workspaceId, status: "error", data: `Failed to spawn "${spec.command}": ${err.message}` });
  });

  child.on("spawn", () => {
    log.info("agent.spawned", { workspace: workspaceId, command: spec.command, pid: child.pid ?? -1 });
    emit({ workspaceId, status: "spawned", pid: child.pid ?? -1 });
  });

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (d: string) => emit({ workspaceId, status: "stdout", data: d }));
  child.stderr?.on("data", (d: string) => emit({ workspaceId, status: "stderr", data: d }));

  child.on("close", (code) => {
    log.info("agent.exit", { workspace: workspaceId, command: spec.command, code: code ?? -1 });
    emit({ workspaceId, status: "exit", code: code ?? -1 });
  });
}
