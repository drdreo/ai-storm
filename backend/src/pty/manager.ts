/**
 * Per-connection PTY session registry (PRD §3.4 workspace isolation).
 *
 * Each workspace maps to at most one live PtySession. The manager guarantees
 * strict isolation: messages routed by `workspaceId` never bleed across
 * workspaces, and tearing one down never disturbs the others (PRD §5.2).
 */

import { defaultShell, PtySession, type PtyOptions } from "./session.ts";
import { LaunchNotFoundError, resolveLaunch } from "./resolve.ts";
import { addEvent, log, withSpan } from "../log.ts";

export class PtyManager {
  #sessions = new Map<string, PtySession>();
  /** Workspaces whose attach is still in flight (launch resolution). */
  #attaching = new Set<string>();
  /** Input that arrived before the PTY existed, flushed once it spawns. */
  #pendingInput = new Map<string, string[]>();

  has(workspaceId: string): boolean {
    return this.#sessions.has(workspaceId);
  }

  /**
   * Create a session, replacing any existing one for the workspace. The launch
   * target (the AI harness or an explicit shell) is resolved for the platform
   * first; resolution failures are reported via `onError` rather than thrown.
   *
   * Resolves with the spawned PTY's pid on success, or `null` if resolution
   * failed (in which case `onError` has already been invoked).
   */
  async attach(
    workspaceId: string,
    opts: PtyOptions,
    onData: (chunk: string) => void,
    onExit: (code: number) => void,
    onError: (message: string) => void,
  ): Promise<number | null> {
    this.detach(workspaceId);
    this.#attaching.add(workspaceId);

    const requestedCmd = opts.shell ?? defaultShell().shell;
    const requestedArgs = opts.shell ? (opts.args ?? []) : defaultShell().args;

    return await withSpan(
      "pty.attach",
      { workspace: workspaceId, "requested.command": requestedCmd },
      (span) => {
        let launch;
        try {
          launch = resolveLaunch(requestedCmd, requestedArgs);
          log.info("attach.resolved", {
            workspace: workspaceId,
            requested: requestedCmd,
            resolvedCmd: launch.cmd,
            resolvedArgs: launch.args.join(" "),
          });
          span.setAttribute("resolved.command", launch.cmd);
          span.setAttribute("resolved.args", launch.args.join(" "));
        } catch (err) {
          this.#attaching.delete(workspaceId);
          this.#pendingInput.delete(workspaceId);
          onError(
            err instanceof LaunchNotFoundError
              ? err.message
              : `Failed to resolve "${requestedCmd}": ` +
                (err instanceof Error ? err.message : String(err)),
          );
          return null;
        }

        const session = new PtySession(
          workspaceId,
          { ...opts, shell: launch.cmd, args: launch.args },
          onData,
          (code) => {
            this.#sessions.delete(workspaceId);
            onExit(code);
          },
        );
        this.#sessions.set(workspaceId, session);
        this.#attaching.delete(workspaceId);
        log.info("pty.spawned", { workspace: workspaceId, pid: session.pid, command: launch.cmd });
        span.setAttribute("pid", session.pid);

        const queued = this.#pendingInput.get(workspaceId);
        if (queued) {
          this.#pendingInput.delete(workspaceId);
          const bytes = queued.reduce((n, d) => n + d.length, 0);
          log.info("input.flush_buffered", { workspace: workspaceId, messages: queued.length, bytes });
          addEvent("flush_buffered_input", { messages: queued.length, bytes });
          for (const data of queued) session.write(data);
        }
        return session.pid;
      },
    );
  }

  write(workspaceId: string, data: string): boolean {
    const session = this.#sessions.get(workspaceId);
    if (session) {
      session.write(data);
      return true;
    }
    // Buffer input that races ahead of an in-flight attach; flushed on spawn.
    if (this.#attaching.has(workspaceId)) {
      const queue = this.#pendingInput.get(workspaceId) ?? [];
      queue.push(data);
      this.#pendingInput.set(workspaceId, queue);
      return true;
    }
    return false;
  }

  resize(workspaceId: string, cols: number, rows: number): boolean {
    const session = this.#sessions.get(workspaceId);
    if (!session) return false;
    session.resize(cols, rows);
    return true;
  }

  detach(workspaceId: string): void {
    this.#attaching.delete(workspaceId);
    this.#pendingInput.delete(workspaceId);
    const session = this.#sessions.get(workspaceId);
    if (!session) return;
    this.#sessions.delete(workspaceId);
    session.kill();
  }

  detachAll(): void {
    for (const id of [...this.#sessions.keys()]) this.detach(id);
  }

  get size(): number {
    return this.#sessions.size;
  }
}
