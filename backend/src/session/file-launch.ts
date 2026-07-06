/**
 * Shared apply step for `HarnessProfile.fileLaunch` (harness-authoring.md
 * §4.x): mkdtemp → compute → write files, with symmetric rollback on both a
 * "nothing to write" result and a thrown error. Both backends drove this by
 * hand (identical ~20-line blocks); centralizing it means the cleanup
 * semantics only need to be right once.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeFileLaunch, type FileLaunchContext, type HarnessProfile } from "./extraction/index.ts";

/** Result of a successful apply: the temp dir to track for cleanup, plus the
 *  env vars and extra CLI args the caller must fold into the launch. */
export interface AppliedFileLaunch {
  dir: string;
  env: Record<string, string>;
  /** Extra launch argv (e.g. pi's `-e <extension.ts>`, #177); `[]` when the
   *  profile's wiring is env-only (opencode). */
  args: string[];
}

/**
 * Applies `profile.fileLaunch` if present. Returns `undefined` if the profile
 * has no `fileLaunch` or it opts out (e.g. idempotency: caller already pinned
 * the env var it would have set) — no temp dir is left behind in that case.
 *
 * On a thrown error, the temp dir is removed and `onRollback` runs (callers
 * use it to release resources minted before this call, e.g. an MCP session
 * token) before the error is rethrown.
 *
 * The temp dir is namespaced by `profile.name` (not a fixed harness name) so
 * a second file-launch harness gets its own label rather than borrowing
 * opencode's.
 */
export function applyFileLaunch(
  profile: HarnessProfile,
  ctx: Omit<FileLaunchContext, "dir">,
  onRollback: () => void
): AppliedFileLaunch | undefined {
  if (!profile.fileLaunch) return undefined;

  const dir = mkdtempSync(join(tmpdir(), `ai-storm-${profile.name}-`));
  try {
    const result = computeFileLaunch(profile, { ...ctx, dir });
    if (!result) {
      rmSync(dir, { recursive: true, force: true });
      return undefined;
    }
    for (const file of result.files) writeFileSync(file.path, file.content, { encoding: "utf-8", mode: 0o600 });
    return { dir, env: result.env, args: result.args ?? [] };
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    onRollback();
    throw err;
  }
}
