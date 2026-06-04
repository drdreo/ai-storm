/**
 * Downstream agent execution hook (PRD §3.6).
 *
 * When the user triggers the contextual macro on a block selection, the client
 * sends an `agent` message. The backend spawns an asynchronous local subprocess
 * invoking the orchestrator command with the extracted plain text passed as a
 * functional argument, and streams the subprocess lifecycle back to the client.
 */

import type { AgentStatusMessage } from "../protocol.ts";

export type AgentEmitter = (msg: Omit<AgentStatusMessage, "type">) => void;

export interface AgentSpec {
  command: string;
  args?: string[];
  payload: string;
  cwd?: string;
}

/**
 * Spawn the agent orchestrator. The payload is appended as the final argument
 * (the "clear functional argument" of PRD §3.6). stdout/stderr are streamed
 * line-buffered back to the caller; the process runs detached from any PTY.
 */
export function runAgent(
  workspaceId: string,
  spec: AgentSpec,
  emit: AgentEmitter,
): void {
  const args = [...(spec.args ?? []), spec.payload];

  let proc: Deno.ChildProcess;
  try {
    const command = new Deno.Command(spec.command, {
      args,
      cwd: spec.cwd,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    proc = command.spawn();
  } catch (err) {
    emit({
      workspaceId,
      status: "error",
      data: `Failed to spawn "${spec.command}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    });
    return;
  }

  emit({ workspaceId, status: "spawned", pid: proc.pid });

  const decoder = new TextDecoder();

  const stream = async (
    src: ReadableStream<Uint8Array>,
    status: "stdout" | "stderr",
  ) => {
    const reader = src.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          emit({ workspaceId, status, data: decoder.decode(value) });
        }
      }
    } catch {
      // stream torn down with the process
    } finally {
      reader.releaseLock();
    }
  };

  void Promise.all([
    stream(proc.stdout, "stdout"),
    stream(proc.stderr, "stderr"),
  ]).then(async () => {
    try {
      const status = await proc.status;
      emit({ workspaceId, status: "exit", code: status.code });
    } catch {
      emit({ workspaceId, status: "exit", code: -1 });
    }
  });
}
