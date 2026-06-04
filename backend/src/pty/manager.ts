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
  /** Workspaces whose async attach (launch resolution) is still in flight. */
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
   */
  async attach(
    workspaceId: string,
    opts: PtyOptions,
    onData: (chunk: string) => void,
    onExit: (code: number) => void,
    onError: (message: string) => void,
  ): Promise<boolean> {
    await this.detach(workspaceId);
    this.#attaching.add(workspaceId);

    const requestedCmd = opts.shell ?? defaultShell().shell;
    const requestedArgs = opts.shell ? (opts.args ?? []) : defaultShell().args;

    return await withSpan(
      "pty.attach",
      { workspace: workspaceId, "requested.command": requestedCmd },
      async (span) => {
        let launch;
        try {
          launch = await resolveLaunch(requestedCmd, requestedArgs);
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
          return false;
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

        // Flush any input that arrived while the launch was being resolved.
        const queued = this.#pendingInput.get(workspaceId);
        if (queued) {
          this.#pendingInput.delete(workspaceId);
          const bytes = queued.reduce((n, d) => n + d.length, 0);
          log.info("input.flush_buffered", {
            workspace: workspaceId,
            messages: queued.length,
            bytes,
          });
          addEvent("flush_buffered_input", { messages: queued.length, bytes });
          for (const data of queued) void session.write(data);
        }
        return true;
      },
    );
  }

  write(workspaceId: string, data: string): boolean {
    const session = this.#sessions.get(workspaceId);
    if (session) {
      void session.write(data);
      return true;
    }
    // Buffer input that races ahead of an in-flight attach; it is flushed when
    // the session spawns. Input with no attach pending is dropped.
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

  async detach(workspaceId: string): Promise<void> {
    this.#attaching.delete(workspaceId);
    this.#pendingInput.delete(workspaceId);
    const session = this.#sessions.get(workspaceId);
    if (!session) return;
    this.#sessions.delete(workspaceId);
    await session.kill();
  }

  /** Tear down every session (connection close / shutdown). */
  async detachAll(): Promise<void> {
    const ids = [...this.#sessions.keys()];
    await Promise.all(ids.map((id) => this.detach(id)));
  }

  get size(): number {
    return this.#sessions.size;
  }
}
