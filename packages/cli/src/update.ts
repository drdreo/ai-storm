/**
 * `ai-storm update` — the upgrade path (issue #216) for a git-based install:
 * fast-forward the checkout, refresh dependencies, rebuild the client, and
 * restart the daemon if one was running. Refuses to touch a dirty tree so a
 * user's local experiments are never clobbered.
 */

import { spawnSync } from "node:child_process";
import { repoRoot } from "./paths.ts";
import { color, info } from "./ui.ts";

function git(root: string, args: string[]): { ok: boolean; out: string } {
  const res = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.trim() };
}

function step(root: string, cmd: string, args: string[]): void {
  info(color.dim(`  $ ${cmd} ${args.join(" ")}`));
  const res = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  if (res.status !== 0) throw new Error(`\`${cmd} ${args.join(" ")}\` failed`);
}

/** Returns true when the checkout actually moved to a new revision. */
export function updateCheckout(root: string = repoRoot()): boolean {
  if (!git(root, ["rev-parse", "--is-inside-work-tree"]).ok) {
    throw new Error(`${root} is not a git checkout — update it the way it was installed.`);
  }

  const dirty = git(root, ["status", "--porcelain"]);
  if (dirty.ok && dirty.out.length > 0) {
    throw new Error("The checkout has local changes; commit or stash them before updating:\n" + dirty.out);
  }

  const before = git(root, ["rev-parse", "HEAD"]).out;
  info("Fetching latest version…");
  const pull = git(root, ["pull", "--ff-only"]);
  if (!pull.ok) {
    throw new Error(`git pull failed:\n${pull.out}`);
  }
  const after = git(root, ["rev-parse", "HEAD"]).out;

  if (before === after) {
    info(`Already up to date (${color.dim(after.slice(0, 9))}).`);
    return false;
  }

  info(`Updated ${color.dim(before.slice(0, 9))} → ${color.bold(after.slice(0, 9))}. Rebuilding…`);
  step(root, "pnpm", ["install"]);
  step(root, "pnpm", ["build"]);
  return true;
}
