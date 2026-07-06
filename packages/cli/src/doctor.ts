/**
 * Preflight checks (`ai-storm doctor`, issue #216): verify the machine can
 * run ai-storm and say exactly what to fix when it can't. The same hard
 * checks run implicitly before `ai-storm start`.
 *
 * Severity model:
 *   fail — the daemon cannot run (old Node, missing pnpm, missing tmux)
 *   warn — degraded but usable (no AI harness found, client not built yet)
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { frontendDistDir, repoRoot } from "./paths.ts";

/** Node needs unflagged type stripping to run the backend's .ts entry point. */
export const MIN_NODE = { major: 22, minor: 18 };

/** Harness CLIs the backend has contract-aware profiles for (extraction/harness.ts). */
export const KNOWN_HARNESSES = ["claude", "codex", "pi", "opencode"] as const;

export interface CheckResult {
  name: string;
  level: "ok" | "warn" | "fail";
  detail: string;
}

/** Pure comparison so it stays unit-testable: is `version` >= MIN_NODE? */
export function nodeVersionSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major !== MIN_NODE.major) return major > MIN_NODE.major;
  return minor >= MIN_NODE.minor;
}

/** Locate `cmd` on PATH; returns its resolved path or null. */
export function which(cmd: string): string | null {
  const probe = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(probe, [cmd], { encoding: "utf8", windowsHide: true });
  if (res.status !== 0 || !res.stdout) return null;
  const first = res.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
  return first?.trim() ?? null;
}

function versionOf(cmd: string, arg = "--version"): string | null {
  const res = spawnSync(cmd, [arg], {
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32"
  });
  if (res.status !== 0 || !res.stdout) return null;
  return res.stdout.trim().split(/\r?\n/)[0] ?? null;
}

/** Run every preflight probe. Cheap (a handful of PATH lookups + stats). */
export function runChecks(root: string = repoRoot()): CheckResult[] {
  const checks: CheckResult[] = [];

  const nodeVersion = process.versions.node;
  checks.push(
    nodeVersionSupported(nodeVersion)
      ? { name: "Node.js", level: "ok", detail: `v${nodeVersion}` }
      : {
          name: "Node.js",
          level: "fail",
          detail: `v${nodeVersion} is too old — ai-storm runs TypeScript directly and needs Node ${MIN_NODE.major}.${MIN_NODE.minor}+ (24 LTS recommended). Install from https://nodejs.org`
        }
  );

  const pnpm = versionOf("pnpm");
  checks.push(
    pnpm
      ? { name: "pnpm", level: "ok", detail: `v${pnpm}` }
      : {
          name: "pnpm",
          level: "fail",
          detail: "not found — enable it with `corepack enable pnpm` or see https://pnpm.io/installation"
        }
  );

  const git = which("git");
  checks.push(
    git
      ? { name: "git", level: "ok", detail: git }
      : { name: "git", level: "warn", detail: "not found — `ai-storm update` needs git to pull new versions" }
  );

  if (process.platform === "win32") {
    checks.push({ name: "terminal runtime", level: "ok", detail: "ConPTY (built into Windows)" });
  } else {
    const tmux = which("tmux");
    checks.push(
      tmux
        ? { name: "tmux", level: "ok", detail: tmux }
        : {
            name: "tmux",
            level: "fail",
            detail:
              "not found — required for durable sessions. Install: sudo apt install tmux (Debian/Ubuntu), sudo dnf install tmux (Fedora), brew install tmux (macOS)"
          }
    );
  }

  const found = KNOWN_HARNESSES.filter((h) => which(h) !== null);
  checks.push(
    found.length > 0
      ? { name: "AI harness", level: "ok", detail: found.join(", ") }
      : {
          name: "AI harness",
          level: "warn",
          detail: `none of [${KNOWN_HARNESSES.join(", ")}] found on PATH — projects can still run a plain shell, but idea extraction needs a contract-aware harness`
        }
  );

  checks.push(
    existsSync(join(root, "node_modules"))
      ? { name: "dependencies", level: "ok", detail: "installed" }
      : {
          name: "dependencies",
          level: "warn",
          detail: "not installed yet — `ai-storm start` runs `pnpm install` automatically"
        }
  );

  checks.push(
    existsSync(join(frontendDistDir(root), "index.html"))
      ? { name: "client bundle", level: "ok", detail: frontendDistDir(root) }
      : { name: "client bundle", level: "warn", detail: "not built yet — `ai-storm start` builds it automatically" }
  );

  return checks;
}

/** The checks that must pass before `start` is allowed to proceed. */
export function hardFailures(checks: CheckResult[]): CheckResult[] {
  return checks.filter((c) => c.level === "fail");
}
