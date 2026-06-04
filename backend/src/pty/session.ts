/**
 * Real pseudo-terminal session backed by node-pty (PRD §4.2).
 *
 * Unlike piped stdio, this allocates a genuine PTY — ConPTY on Windows, a
 * forkpty on POSIX — so interactive CLIs (Claude Code, aider, a shell) run in a
 * true TTY: full-screen TUIs render, raw-mode key handling works, and the
 * program emits ANSI exactly as it would in a real terminal. The client owns
 * all sanitising/parsing of that stream (PRD §3.3).
 */

import ptyDefault from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";

// node-pty ships as CommonJS; the default import is its module.exports.
const pty = ptyDefault as unknown as typeof import("@lydell/node-pty");

export interface PtyOptions {
  /** Binary to spawn. Defaults to the platform interactive shell. */
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export type PtyDataHandler = (chunk: string) => void;
export type PtyExitHandler = (code: number) => void;

/** Resolve the default interactive shell for the current platform. */
export function defaultShell(): { shell: string; args: string[] } {
  if (process.platform === "win32") {
    return { shell: "powershell.exe", args: [] };
  }
  return { shell: process.env.SHELL ?? "/bin/bash", args: ["-i"] };
}

export class PtySession {
  readonly workspaceId: string;
  #term: IPty | null = null;
  #closed = false;
  cols: number;
  rows: number;

  constructor(
    workspaceId: string,
    opts: PtyOptions,
    onData: PtyDataHandler,
    onExit: PtyExitHandler,
  ) {
    this.workspaceId = workspaceId;
    this.cols = opts.cols ?? 120;
    this.rows = opts.rows ?? 30;

    const fallback = defaultShell();
    const shell = opts.shell ?? fallback.shell;
    const args = opts.args ?? (opts.shell ? [] : fallback.args);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === "string") env[k] = v;
    }
    Object.assign(env, opts.env, {
      TERM: opts.env?.TERM ?? "xterm-256color",
      COLORTERM: "truecolor",
      FORCE_COLOR: opts.env?.FORCE_COLOR ?? "1",
    });

    try {
      this.#term = pty.spawn(shell, args, {
        name: "xterm-256color",
        cols: this.cols,
        rows: this.rows,
        cwd: opts.cwd ?? process.cwd(),
        env,
      });
    } catch (err) {
      this.#closed = true;
      const message = `\r\n[ai-storm] failed to launch "${shell}": ` +
        (err instanceof Error ? err.message : String(err)) + "\r\n";
      queueMicrotask(() => {
        onData(message);
        onExit(127);
      });
      return;
    }

    this.#term.onData((data) => {
      if (!this.#closed) onData(data);
    });
    this.#term.onExit(({ exitCode }) => {
      if (this.#closed) return;
      this.#closed = true;
      onExit(exitCode);
    });
  }

  get pid(): number {
    return this.#term?.pid ?? -1;
  }

  write(data: string): void {
    if (this.#closed || !this.#term) return;
    try {
      this.#term.write(data);
    } catch {
      // terminal torn down; exit handler reports termination.
    }
  }

  /** Forward a viewport resize to the kernel PTY (real SIGWINCH). */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.#closed || !this.#term) return;
    try {
      this.#term.resize(cols, rows);
    } catch {
      // ignore resize on a dead terminal
    }
  }

  kill(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#term?.kill();
    } catch {
      // already dead
    }
  }
}
