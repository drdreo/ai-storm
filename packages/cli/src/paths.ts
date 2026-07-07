/**
 * Platform-appropriate filesystem locations for the ai-storm launcher (#216).
 *
 * The CLI keeps its runtime bookkeeping (daemon pidfile, logs) OUTSIDE the
 * repository checkout so `ai-storm update` (a git pull) never collides with a
 * running daemon's state, and so logs survive a re-clone:
 *
 *   Linux    $XDG_STATE_HOME/ai-storm   (default ~/.local/state/ai-storm)
 *   macOS    ~/Library/Application Support/ai-storm
 *   Windows  %LOCALAPPDATA%\ai-storm
 *
 * Everything here is pure path math (no I/O) so it stays unit-testable.
 */

import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/** Minimal view of the process environment the path logic depends on. */
export interface PlatformEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

export function currentPlatformEnv(): PlatformEnv {
  return { platform: process.platform, env: process.env, home: homedir() };
}

/**
 * Join with the TARGET platform's separator (not the host's), so these
 * helpers stay correct when a PlatformEnv simulates another OS in tests.
 */
function joinFor(p: PlatformEnv, ...parts: string[]): string {
  return (p.platform === "win32" ? win32 : posix).join(...parts);
}

/** Root directory for CLI state (pidfile, logs). Created lazily by callers. */
export function stateDir(p: PlatformEnv = currentPlatformEnv()): string {
  if (p.platform === "win32") {
    return joinFor(p, p.env.LOCALAPPDATA ?? joinFor(p, p.home, "AppData", "Local"), "ai-storm");
  }
  if (p.platform === "darwin") {
    return joinFor(p, p.home, "Library", "Application Support", "ai-storm");
  }
  return joinFor(p, p.env.XDG_STATE_HOME ?? joinFor(p, p.home, ".local", "state"), "ai-storm");
}

export function logsDir(p: PlatformEnv = currentPlatformEnv()): string {
  return joinFor(p, stateDir(p), "logs");
}

export function backendLogFile(p: PlatformEnv = currentPlatformEnv()): string {
  return joinFor(p, logsDir(p), "backend.log");
}

/** Pidfile-equivalent: JSON record describing the supervised daemon. */
export function daemonStateFile(p: PlatformEnv = currentPlatformEnv()): string {
  return joinFor(p, stateDir(p), "daemon.json");
}

/**
 * The repository root, derived from this file's on-disk location
 * (`<root>/packages/cli/src/paths.ts`). Works no matter where the shim that
 * invoked the CLI lives, because Node resolves the entry through realpath.
 */
export function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

export function frontendDistDir(root: string = repoRoot()): string {
  return join(root, "frontend", "dist");
}

export function backendEntry(root: string = repoRoot()): string {
  return join(root, "backend", "src", "main.ts");
}
