/**
 * Runtime selection for the session layer (design §2.1).
 *
 *   getDefaultRuntime() → "tmux" on POSIX (Linux/macOS), "process" on Windows.
 *
 * A single backend instance is shared across all WebSocket connections because
 * the durable sessions outlive any one connection (PRD §3.5): a tmux session
 * survives a browser refresh, so reconnecting must find the same backend that
 * is already polling it. `getRuntime()` lazily constructs that singleton.
 */

import type { SessionBackend } from "./types.ts";
import { TmuxSessionBackend } from "./tmux-backend.ts";
import { NodePtySessionBackend } from "./nodepty-backend.ts";

export function getDefaultRuntime(): "tmux" | "process" {
  return process.platform === "win32" ? "process" : "tmux";
}

let singleton: SessionBackend | null = null;

/** The process-wide session backend, constructed once per the platform. */
export function getRuntime(): SessionBackend {
  if (singleton) return singleton;
  singleton = getDefaultRuntime() === "tmux" ? new TmuxSessionBackend() : new NodePtySessionBackend();
  return singleton;
}

/** Test seam: reset the singleton so a fresh backend is built next call. */
export function resetRuntime(): void {
  singleton = null;
}
