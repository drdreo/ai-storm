/**
 * Cross-platform launch resolution.
 *
 * The interactive session defaults to the user's AI harness (e.g. `claude`),
 * which on Windows is almost always an npm `.cmd`/`.ps1` shim rather than a PE
 * executable. `Deno.Command` cannot spawn those directly and does not apply
 * PATHEXT, so we resolve the real target via `where.exe` and wrap script shims
 * in their interpreter. On POSIX the kernel resolves PATH for us, so the
 * command is returned unchanged.
 */

import { log } from "../log.ts";

export interface ResolvedLaunch {
  cmd: string;
  args: string[];
}

export class LaunchNotFoundError extends Error {
  constructor(public command: string) {
    super(
      `Could not find "${command}" on PATH. Is your AI harness installed and ` +
        `on PATH? You can change the harness command in the workspace settings.`,
    );
    this.name = "LaunchNotFoundError";
  }
}

function hasPathSeparator(s: string): boolean {
  return s.includes("/") || s.includes("\\");
}

/** Resolve a command + args into something `Deno.Command` can actually spawn. */
export async function resolveLaunch(
  command: string,
  args: string[],
): Promise<ResolvedLaunch> {
  if (Deno.build.os !== "windows") {
    return { cmd: command, args };
  }

  // An explicit path is used as-is (caller knows what they want).
  if (hasPathSeparator(command)) {
    return wrapByExtension(command, args);
  }

  // Resolve via `where.exe`, which honours PATH + PATHEXT. It can return
  // several candidates (e.g. a `.cmd` npm shim plus an extensionless Git-Bash
  // script); pick the one Windows can actually CreateProcess.
  const candidates = await whereExe(command);
  log.debug("resolve.candidates", { command, candidates: candidates.join(" | ") });
  if (candidates.length === 0) throw new LaunchNotFoundError(command);
  const chosen = chooseBest(candidates);
  const wrapped = wrapByExtension(chosen, args);
  log.debug("resolve.chosen", { command, chosen, launch: `${wrapped.cmd} ${wrapped.args.join(" ")}` });
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

async function whereExe(command: string): Promise<string[]> {
  try {
    const out = await new Deno.Command("where.exe", {
      args: [command],
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!out.success) return [];
    return new TextDecoder()
      .decode(out.stdout)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function wrapByExtension(target: string, args: string[]): ResolvedLaunch {
  const lower = target.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    // Batch shims must run through cmd.exe.
    return { cmd: "cmd.exe", args: ["/d", "/s", "/c", target, ...args] };
  }
  if (lower.endsWith(".ps1")) {
    return {
      cmd: "powershell.exe",
      args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-File", target, ...args],
    };
  }
  // .exe / .com / extensionless native binary.
  return { cmd: target, args };
}
