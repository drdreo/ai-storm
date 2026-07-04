/**
 * Cross-platform launch resolution.
 *
 * node-pty/ConPTY ultimately calls CreateProcess on Windows, which can run
 * `.exe` binaries and (with PATH search) extensionless names, but NOT npm
 * `.cmd`/`.ps1` shims directly. We resolve the real target via `where.exe`
 * and wrap script shims in their interpreter. On POSIX the kernel resolves
 * PATH, so the command is returned unchanged.
 */

import { spawnSync } from "node:child_process";
import { log } from "../log.ts";

export interface ResolvedLaunch {
  cmd: string;
  args: string[];
}

export class LaunchNotFoundError extends Error {
  command: string;
  constructor(command: string) {
    super(
      `Could not find "${command}" on PATH. Is your AI harness installed and ` +
        `on PATH? You can change the harness command in the workspace settings.`
    );
    this.name = "LaunchNotFoundError";
    this.command = command;
  }
}

function hasPathSeparator(s: string): boolean {
  return s.includes("/") || s.includes("\\");
}

/**
 * STRICT launch-token validation (#142), applied only to client-triggered
 * one-shot agent runs (`strict: true`): their args are supposed to be short
 * static flags, so control characters (NUL, ESC, CR/LF, …) are never
 * legitimate there. PTY session launches must NOT use this — their argv
 * legitimately carries multi-line text (the `--append-system-prompt` prime,
 * PD-020) and JSON with quotes (`--mcp-config`); they get the NUL-only check
 * in `resolveLaunch` instead.
 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function assertNoControlCharacters(command: string, args: readonly string[]): void {
  if (CONTROL_CHARS.test(command)) {
    throw new Error("Unsafe launch command: control characters are not allowed.");
  }
  if (args.some((a) => CONTROL_CHARS.test(a))) {
    throw new Error("Unsafe launch argument: control characters are not allowed.");
  }
}

/**
 * cmd.exe does NOT parse its command line with CommandLineToArgvW — it has its
 * own rules — so Node's per-argument quoting cannot neutralize cmd
 * metacharacters (BatBadBut, CVE-2024-24576 class): an argument like `x&calc`
 * needs no argv quoting, survives verbatim onto the `/c` line, and cmd runs
 * `calc`. Escaping for cmd is famously not round-trippable, so tokens headed
 * for a `.cmd`/`.bat` wrap are REJECTED outright when they carry any cmd
 * metacharacter. Legitimate harness flags (`--model=opus`,
 * `--allowedTools Bash(gh issue create:*)`) never contain these (#142).
 */
const CMD_METACHARS = /[&|<>^%"\r\n]/;

export function assertCmdSafeTokens(target: string, args: readonly string[]): void {
  if ([target, ...args].some((t) => CMD_METACHARS.test(t))) {
    throw new Error(
      `Unsafe argument for a cmd.exe-wrapped launch: ` +
        `cmd metacharacters (& | < > ^ % " or line breaks) are not allowed.`
    );
  }
}

/**
 * Split a launch line into `[executable, ...args]`, honoring single/double
 * quotes so a quoted path with spaces stays one token. This lets a user type a
 * whole command line — `claude --model=opus` or `"C:\Program Files\x\pi.exe"
 * --model gpt-4o` — into the single harness field, instead of the field being
 * mistaken for an executable literally named "claude --model=opus".
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

/**
 * Has the model flag already been supplied, in either separate (`--model x`)
 * or combined (`--model=x`) form? Used to avoid appending a duplicate default.
 */
export function hasFlag(args: readonly string[], flag: string): boolean {
  return args.some((a) => a === flag || a.startsWith(`${flag}=`));
}

export interface ResolveOptions {
  /**
   * Strict token validation (#142) for client-triggered one-shot agent runs:
   * no control characters anywhere, no cmd metacharacters into a `.cmd`/`.bat`
   * wrap. PTY sessions stay non-strict — their argv legitimately carries the
   * multi-line prime and quoted JSON (see `CONTROL_CHARS` note).
   */
  strict?: boolean;
}

export function resolveLaunch(command: string, args: string[], opts: ResolveOptions = {}): ResolvedLaunch {
  if (opts.strict) {
    assertNoControlCharacters(command, args);
  } else if ([command, ...args].some((t) => t.includes("\u0000"))) {
    // NUL is never legal in any argv on any platform; everything else is the
    // session owner's business.
    throw new Error("Unsafe launch argument: NUL bytes are not allowed.");
  }
  if (process.platform !== "win32") {
    return { cmd: command, args };
  }
  if (hasPathSeparator(command)) {
    return wrapByExtension(command, args, opts);
  }

  const candidates = whereExe(command);
  log.debug("resolve.candidates", { command, candidates: candidates.join(" | ") });
  if (candidates.length === 0) throw new LaunchNotFoundError(command);

  const chosen = chooseBest(candidates);
  const wrapped = wrapByExtension(chosen, args, opts);
  log.debug("resolve.chosen", {
    command,
    chosen,
    launch: `${wrapped.cmd} ${wrapped.args.join(" ")}`
  });
  return wrapped;
}

// Native binaries first, then batch shims, then PowerShell scripts. An
// extensionless match (a Unix-style shell script) is unusable by CreateProcess.
const EXT_PRIORITY = [".exe", ".com", ".cmd", ".bat", ".ps1"];

function chooseBest(candidates: string[]): string {
  for (const ext of EXT_PRIORITY) {
    const hit = candidates.find((c) => c.toLowerCase().endsWith(ext));
    if (hit) return hit;
  }
  return candidates[0];
}

function whereExe(command: string): string[] {
  try {
    const out = spawnSync("where.exe", [command], { encoding: "utf8" });
    if (out.status !== 0 || !out.stdout) return [];
    return out.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function wrapByExtension(target: string, args: string[], opts: ResolveOptions = {}): ResolvedLaunch {
  const lower = target.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    // cmd.exe re-parses the /c line with its own (non-argv) rules; for strict
    // (agent-run) launches, refuse any token it could interpret as shell
    // syntax rather than trying to escape. Session launches keep their
    // pre-#142 behaviour (the prime/JSON args predate this check).
    if (opts.strict) assertCmdSafeTokens(target, args);
    return { cmd: "cmd.exe", args: ["/d", "/s", "/c", target, ...args] };
  }
  if (lower.endsWith(".ps1")) {
    return {
      cmd: "powershell.exe",
      args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-File", target, ...args]
    };
  }
  return { cmd: target, args };
}
