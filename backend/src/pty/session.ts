/**
 * PTY session abstraction (PRD §4.2).
 *
 * The backend spawns local terminal binaries / running system sessions and
 * streams their raw stdout to the client. Deno has no built-in PTY, so the
 * default implementation uses `Deno.Command` with piped stdio. This produces
 * a real child process whose stdout (including ANSI sequences from most CLI
 * tools) is forwarded verbatim; the client owns all sanitising/parsing per
 * PRD §3.3. The abstraction is intentionally narrow so a true conpty/openpty
 * backend (e.g. npm:node-pty) can be substituted without touching callers.
 */

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
  if (Deno.build.os === "windows") {
    return { shell: "powershell.exe", args: ["-NoLogo", "-NoExit"] };
  }
  const shell = Deno.env.get("SHELL") ?? "/bin/bash";
  return { shell, args: ["-i"] };
}

export class PtySession {
  readonly workspaceId: string;
  #proc: Deno.ChildProcess | null = null;
  #stdin: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #encoder = new TextEncoder();
  #decoder = new TextDecoder();
  #onData: PtyDataHandler;
  #onExit: PtyExitHandler;
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
    this.#onData = onData;
    this.#onExit = onExit;
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 24;

    // `shell`/`args` are expected to be already resolved by the PtyManager
    // (PATHEXT/shim resolution happens there). Fall back to the platform shell
    // only if nothing was provided.
    const fallback = defaultShell();
    const shell = opts.shell ?? fallback.shell;
    const args = opts.args ?? (opts.shell ? [] : fallback.args);

    const command = new Deno.Command(shell, {
      args,
      cwd: opts.cwd,
      env: {
        ...opts.env,
        // Many CLIs colorize only when they detect a TTY; nudge them to emit
        // ANSI anyway so the client's sanitiser (PRD §3.3) is exercised.
        TERM: opts.env?.TERM ?? "xterm-256color",
        FORCE_COLOR: opts.env?.FORCE_COLOR ?? "1",
        COLUMNS: String(this.cols),
        LINES: String(this.rows),
      },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    try {
      this.#proc = command.spawn();
    } catch (err) {
      // Surface the failure as data + a non-zero exit instead of crashing.
      this.#closed = true;
      const message =
        `\r\n[ai-storm] failed to launch "${shell}": ` +
        (err instanceof Error ? err.message : String(err)) + "\r\n";
      queueMicrotask(() => {
        this.#onData(message);
        this.#onExit(127);
      });
      return;
    }

    this.#stdin = this.#proc.stdin.getWriter();
    this.#pump(this.#proc.stdout);
    this.#pump(this.#proc.stderr);
    this.#watchExit();
  }

  get pid(): number {
    return this.#proc?.pid ?? -1;
  }

  /** Drain a readable byte stream into the data handler. */
  async #pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0 && !this.#closed) {
          this.#onData(this.#decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      // Stream closed during teardown — exit is handled by #watchExit.
    } finally {
      reader.releaseLock();
    }
  }

  async #watchExit(): Promise<void> {
    if (!this.#proc) return;
    try {
      const status = await this.#proc.status;
      if (!this.#closed) {
        this.#closed = true;
        this.#onExit(status.code);
      }
    } catch {
      if (!this.#closed) {
        this.#closed = true;
        this.#onExit(-1);
      }
    }
  }

  /** Forward text to the child's stdin. */
  async write(data: string): Promise<void> {
    if (this.#closed || !this.#stdin) return;
    try {
      await this.#stdin.write(this.#encoder.encode(data));
    } catch {
      // stdin closed; the exit watcher will report termination.
    }
  }

  /**
   * Record a resize. The piped-stdio backend cannot signal SIGWINCH, so this
   * stores the dimensions and updates the COLUMNS/LINES the child reads on
   * next query. A true PTY backend would forward this to the kernel.
   */
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  async kill(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#stdin?.close();
    } catch { /* already closed */ }
    try {
      this.#proc?.kill("SIGTERM");
    } catch { /* already dead */ }
  }
}
