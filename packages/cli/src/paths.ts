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
import { dirname, join, resolve } from "node:path";
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

/** Root directory for CLI state (pidfile, logs). Created lazily by callers. */
export function stateDir(p: PlatformEnv = currentPlatformEnv()): string {
  if (p.platform === "win32") {
    return join(p.env.LOCALAPPDATA ?? join(p.home, "AppData", "Local"), "ai-storm");
  }
  if (p.platform === "darwin") {
    return join(p.home, "Library", "Application Support", "ai-storm");
  }
  return join(p.env.XDG_STATE_HOME ?? join(p.home, ".local", "state"), "ai-storm");
}

export function logsDir(p: PlatformEnv = currentPlatformEnv()): string {
  return join(stateDir(p), "logs");
}

export function backendLogFile(p: PlatformEnv = currentPlatformEnv()): string {
  return join(logsDir(p), "backend.log");
}

/** Pidfile-equivalent: JSON record describing the supervised daemon. */
export function daemonStateFile(p: PlatformEnv = currentPlatformEnv()): string {
  return join(stateDir(p), "daemon.json");
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
