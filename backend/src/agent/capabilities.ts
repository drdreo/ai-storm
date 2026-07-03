/**
 * Per-run capability injection for the downstream agent seam (#120).
 *
 * The client never widens an agent's permissions by sending raw argv — it
 * requests a NAMED capability, and this module maps it to a hardcoded,
 * backend-owned flag for the specific harness command being spawned. This
 * keeps the executor's trust model intact (only static backend-owned strings
 * reach the command line) while scoping side effects like `gh issue create`
 * to the single run that opted in, instead of the user baking the permission
 * into the workspace's global agent args (where it would apply to EVERY
 * hand-off).
 *
 * The table is deliberately tiny: one capability, one recognized command.
 * Adding a capability is a row here plus the shared `AgentCapability` union —
 * never a client-supplied string.
 */

import type { AgentCapability } from "@ai-storm/shared";

/**
 * capability → recognized harness command → extra argv. Argv entries are
 * separate tokens (flag, value) so no shell-quoting layer ever re-parses them.
 */
const CAPABILITY_TABLE: Record<AgentCapability, Record<string, readonly string[]>> = {
  "create-issues": {
    claude: ["--allowedTools", "Bash(gh issue create:*)"]
  }
};

/**
 * The command's bare name for table lookup: strip any directory path and a
 * Windows launcher extension, lowercase. A user-typed command line may carry
 * flags (`claude --model=opus`) — only the first token names the executable.
 */
function commandBaseName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const base = first.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(exe|cmd|bat|ps1|com)$/i, "").toLowerCase();
}

export interface ResolvedCapabilities {
  /** Backend-owned argv to append to the spawn args. */
  args: string[];
  /** Requested capabilities the command is not vetted for — refused, never widened silently. */
  rejected: AgentCapability[];
}

/**
 * Resolve the requested capabilities against the vetted table for `command`.
 * A capability the command has no row for lands in `rejected` so the caller
 * can surface WHY it was ignored (a `stderr` status), rather than silently
 * granting or dropping it.
 */
export function resolveCapabilities(
  command: string,
  capabilities: readonly AgentCapability[] | undefined
): ResolvedCapabilities {
  const args: string[] = [];
  const rejected: AgentCapability[] = [];
  const base = commandBaseName(command);
  for (const cap of capabilities ?? []) {
    const extra = CAPABILITY_TABLE[cap]?.[base];
    if (extra) args.push(...extra);
    else rejected.push(cap);
  }
  return { args, rejected };
}
