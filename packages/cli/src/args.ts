/**
 * Minimal argv parsing for the launcher — one subcommand plus a small, fixed
 * set of flags. Deliberately not a general-purpose parser: unknown flags are
 * an error so typos (`--prot 9000`) fail loudly instead of being ignored.
 */

export interface CliOptions {
  command: string;
  /** `--port <n>` — preferred listen port (default 8787, or AI_STORM_PORT). */
  port?: number;
  /** `--no-open` — don't launch the browser after start. */
  noOpen: boolean;
  /** `--foreground` — run the daemon attached to this terminal. */
  foreground: boolean;
  /** `--follow` / `-f` — stream the log file (logs command). */
  follow: boolean;
  /** `--lines <n>` / `-n <n>` — how many trailing log lines to print. */
  lines: number;
  /** `--json` — machine-readable output (status command). */
  json: boolean;
}

export const COMMANDS = ["start", "stop", "restart", "status", "logs", "doctor", "update", "help", "version"] as const;

export function parseCliArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    command: "start",
    noOpen: false,
    foreground: false,
    follow: false,
    lines: 50,
    json: false
  };

  const rest = [...argv];
  if (rest[0] !== undefined && !rest[0].startsWith("-")) {
    opts.command = rest.shift() as string;
  } else if (rest[0] === "--help" || rest[0] === "-h") {
    rest.shift();
    opts.command = "help";
  } else if (rest[0] === "--version" || rest[0] === "-v") {
    rest.shift();
    opts.command = "version";
  }

  if (!(COMMANDS as readonly string[]).includes(opts.command)) {
    throw new Error(`Unknown command "${opts.command}". Run \`ai-storm help\`.`);
  }

  while (rest.length > 0) {
    const arg = rest.shift() as string;
    switch (arg) {
      case "--port": {
        const port = Number(rest.shift());
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error("--port expects an integer between 1 and 65535");
        }
        opts.port = port;
        break;
      }
      case "--no-open":
        opts.noOpen = true;
        break;
      case "--foreground":
        opts.foreground = true;
        break;
      case "--follow":
      case "-f":
        opts.follow = true;
        break;
      case "--lines":
      case "-n": {
        const lines = Number(rest.shift());
        if (!Number.isInteger(lines) || lines < 0) {
          throw new Error("--lines expects a non-negative integer");
        }
        opts.lines = lines;
        break;
      }
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        opts.command = "help";
        break;
      default:
        throw new Error(`Unknown option "${arg}". Run \`ai-storm help\`.`);
    }
  }

  return opts;
}
