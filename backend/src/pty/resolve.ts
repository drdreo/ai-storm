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
        `on PATH? You can change the harness command in the workspace settings.`,
    );
    this.name = "LaunchNotFoundError";
    this.command = command;
  }
}

function hasPathSeparator(s: string): boolean {
  return s.includes("/") || s.includes("\\");
}

export function resolveLaunch(command: string, args: string[]): ResolvedLaunch {
  if (process.platform !== "win32") {
    return { cmd: command, args };
  }
  if (hasPathSeparator(command)) {
    return wrapByExtension(command, args);
  }

  const candidates = whereExe(command);
  log.debug("resolve.candidates", { command, candidates: candidates.join(" | ") });
  if (candidates.length === 0) throw new LaunchNotFoundError(command);

  const chosen = chooseBest(candidates);
  const wrapped = wrapByExtension(chosen, args);
  log.debug("resolve.chosen", {
    command,
    chosen,
    launch: `${wrapped.cmd} ${wrapped.args.join(" ")}`,
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

function wrapByExtension(target: string, args: string[]): ResolvedLaunch {
  const lower = target.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    return { cmd: "cmd.exe", args: ["/d", "/s", "/c", target, ...args] };
  }
  if (lower.endsWith(".ps1")) {
    return {
      cmd: "powershell.exe",
      args: ["-NoLogo", "-ExecutionPolicy", "Bypass", "-File", target, ...args],
    };
  }
  return { cmd: target, args };
}
