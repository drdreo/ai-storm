/**
 * Per-connection PTY session registry (PRD §3.4 workspace isolation).
 *
 * Each workspace maps to at most one live PtySession. The manager guarantees
 * strict isolation: messages routed by `workspaceId` never bleed across
 * workspaces, and tearing one down never disturbs the others (PRD §5.2).
 */

import { PtySession, type PtyOptions } from "./session.ts";

export class PtyManager {
  #sessions = new Map<string, PtySession>();

  has(workspaceId: string): boolean {
    return this.#sessions.has(workspaceId);
  }

  /** Create a session, replacing any existing one for the workspace. */
  attach(
    workspaceId: string,
    opts: PtyOptions,
    onData: (chunk: string) => void,
    onExit: (code: number) => void,
  ): PtySession {
    this.detach(workspaceId);
    const session = new PtySession(
      workspaceId,
      opts,
      onData,
      (code) => {
        this.#sessions.delete(workspaceId);
        onExit(code);
      },
    );
    this.#sessions.set(workspaceId, session);
    return session;
  }

  write(workspaceId: string, data: string): boolean {
    const session = this.#sessions.get(workspaceId);
    if (!session) return false;
    void session.write(data);
    return true;
  }

  resize(workspaceId: string, cols: number, rows: number): boolean {
    const session = this.#sessions.get(workspaceId);
    if (!session) return false;
    session.resize(cols, rows);
    return true;
  }

  async detach(workspaceId: string): Promise<void> {
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
