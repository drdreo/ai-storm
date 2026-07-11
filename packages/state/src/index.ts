import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** The environment inputs used to resolve the state root. Injectable for tests. */
export interface StatePlatformEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

export function currentStatePlatformEnv(): StatePlatformEnv {
  return { platform: process.platform, env: process.env, home: homedir() };
}

function pathsFor(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

/**
 * Resolve the one durable ai-storm state root shared by the launcher and backend.
 * A relative AI_STORM_STATE_DIR is ignored so daemon cwd changes cannot redirect
 * durable state accidentally.
 */
export function resolveStateDir(p: StatePlatformEnv = currentStatePlatformEnv()): string {
  const path = pathsFor(p.platform);
  const override = p.env.AI_STORM_STATE_DIR?.trim();
  if (override && path.isAbsolute(override)) return path.normalize(override);

  if (p.platform === "win32") {
    const local = p.env.LOCALAPPDATA || path.join(p.home, "AppData", "Local");
    return path.join(local, "ai-storm");
  }
  if (p.platform === "darwin") return path.join(p.home, "Library", "Application Support", "ai-storm");
  return path.join(p.env.XDG_STATE_HOME || path.join(p.home, ".local", "state"), "ai-storm");
}
