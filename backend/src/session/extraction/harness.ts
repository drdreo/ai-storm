/**
 * Harness profiles + launch-argv assembly (extraction-contract §5, §7.2).
 *
 * A profile captures the per-CLI rules the session layer needs at launch:
 * whether the harness understands the §4 idea contract (→ prime it), which
 * flag injects launch-time instructions, default model/config args, and how
 * to wire the backend MCP server (mcp-idea-capture §4.3). The scanning half
 * of the contract lives in `./markers.ts` / `./scanner.ts`.
 */

/**
 * Everything a harness profile needs to wire itself to the backend MCP server
 * at launch (mcp-idea-capture §4.3). Built backend-side at `create()` — the
 * URL embeds the per-session routing token, so it is never derived from
 * anything the model says.
 */
export interface McpLaunchContext {
  /** Per-session MCP endpoint: `http://127.0.0.1:<port>/mcp/<projectId>/<token>`. */
  url: string;
  /** Logical MCP server name ("ai-storm"); harness tool ids derive from it
   *  (`mcp__<serverName>__capture_idea`). Fixed so `--allowedTools` stays stable. */
  serverName: string;
}

/**
 * Per-harness rules. Reduced to what the idea scan still needs: whether the
 * harness understands the §4 idea contract (→ prime it) and the pane signature
 * meaning "ready for input" (the priming readiness probe). The chat-extraction
 * fields (prompt/chrome/response/completion markers) are gone — the terminal
 * renders itself now.
 */
export interface HarnessProfile {
  name: string;
  /**
   * Does this harness understand the §4 idea contract (→ prime it)? A bare
   * shell / non-AI command sets this false and is never primed.
   */
  supportsIdeaContract: boolean;
  /**
   * CLI/config flag this harness uses to inject launch-time instructions. When
   * set and a prime text is given, the backend launches the harness with
   * `[systemPromptFlag, systemPromptValue(primeText)]` so the idea contract is
   * part of the system/developer prompt — followed from the first turn, with
   * nothing typed into the terminal (far more reliable than injecting a priming
   * message). Absent → no priming.
   */
  systemPromptFlag?: string;
  /** Transform the prime text into the value paired with `systemPromptFlag`. */
  systemPromptValue?: (prime: string) => string;
  /** Default CLI flags for this harness unless the caller already supplied them. */
  defaultArgs?: string[];
  /**
   * CLI flag this harness uses to select a model, paired with `defaultModel`.
   * When both are set the backend launches the harness with `[modelFlag,
   * defaultModel]` — unless the caller already passed `modelFlag` in the args —
   * so a profile can default to a fast/cheap model without the user typing it.
   */
  modelFlag?: string;
  /** Model passed via `modelFlag` at launch when the caller supplies none. */
  defaultModel?: string;
  /** One-off Codex/pi-style config overrides appended unless the caller supplies the key. */
  defaultConfig?: Record<string, string>;
  /**
   * Build the CLI args that wire this harness to the backend MCP server
   * (mcp-idea-capture §4.3). Absent → the harness gets no MCP and stays on the
   * marker-scan path — graceful degradation by construction (§11.6): codex/pi
   * stay markers-only until their MCP config surfaces are verified against
   * pinned versions (§11.2). Presence also selects the MCP base prime over the
   * marker prime (§5) — one mechanism per session.
   */
  mcpArgs?: (ctx: McpLaunchContext) => string[];
}

/** A generic harness understands no contract until proven otherwise. */
export const DEFAULT_PROFILE: HarnessProfile = {
  name: "default",
  supportsIdeaContract: false
};

/**
 * The claude harness profile. `supportsIdeaContract` enables priming, delivered
 * via claude's `--append-system-prompt` flag at launch.
 */
export const CLAUDE_PROFILE: HarnessProfile = {
  name: "claude",
  supportsIdeaContract: true,
  systemPromptFlag: "--append-system-prompt",
  modelFlag: "--model",
  // Default to a fast, cheap model for the idea-scanning session; the user can
  // still override with an explicit `--model` in the harness args.
  defaultModel: "haiku",
  // MCP wiring (mcp-idea-capture §4.3): inline `--mcp-config` plus pre-allowed
  // tool ids so no permission prompt interrupts the brainstorm (§12.3).
  mcpArgs: ({ url, serverName }) => [
    "--mcp-config",
    JSON.stringify({ mcpServers: { [serverName]: { type: "http", url } } }),
    "--allowedTools",
    `mcp__${serverName}__capture_idea,mcp__${serverName}__capture_score`
  ]
};

/**
 * The pi harness profile. Pi intentionally supports the same system-prompt and
 * model flags we rely on for Claude Code, so it can be primed at launch through
 * the same profile seam and then driven as a real interactive TUI.
 */
export const PI_PROFILE: HarnessProfile = {
  name: "pi",
  supportsIdeaContract: true,
  systemPromptFlag: "--append-system-prompt",
  modelFlag: "--model"
  // No defaultModel: pi is multi-provider and already has user/project default
  // model settings. Forcing haiku here would break users authenticated through
  // OpenAI, Copilot, Gemini, etc.; explicit `--model` args still pass through.
};

/**
 * The Codex CLI profile. Codex has no `--append-system-prompt` flag; the
 * supported launch seam is a one-off config override, so we inject the same
 * idea contract as `developer_instructions` via `-c`. `--no-alt-screen` keeps
 * the conversation in tmux's normal scrollback so `capture-pane` can see the
 * emitted `«IDEA»` / `«SCORE»` markers instead of an alternate-screen TUI.
 */
export const CODEX_PROFILE: HarnessProfile = {
  name: "codex",
  supportsIdeaContract: true,
  systemPromptFlag: "-c",
  systemPromptValue: (prime) => `developer_instructions=${JSON.stringify(prime)}`,
  defaultArgs: ["--no-alt-screen"],
  modelFlag: "--model",
  // Keep the live brainstorming harness fast/cheap by default. Users can still
  // override with explicit `--model` / `-c model_reasoning_effort=...` args.
  defaultModel: "gpt-5.3-codex-spark",
  defaultConfig: { model_reasoning_effort: JSON.stringify("medium") }
};

const PROFILES: Record<string, HarnessProfile> = {
  default: DEFAULT_PROFILE,
  claude: CLAUDE_PROFILE,
  pi: PI_PROFILE,
  codex: CODEX_PROFILE,
  bash: { ...DEFAULT_PROFILE, name: "bash" },
  python: { ...DEFAULT_PROFILE, name: "python" }
};

/**
 * Build the final argv for a contract-aware harness profile. Kept here so tmux
 * and node-pty launch paths stay byte-for-byte aligned. `mcp` is the optional
 * MCP launch context (mcp-idea-capture §4.3): only a profile that declares
 * `mcpArgs` consumes it, and — like the model/config args — the injection is
 * idempotent against a caller who already supplied `--mcp-config` themselves.
 * Absent `mcp` (or absent `mcpArgs`) leaves the argv byte-identical to before.
 */
export function launchArgsForProfile(
  profile: HarnessProfile,
  baseArgs: string[],
  prime?: string,
  mcp?: McpLaunchContext
): string[] {
  const defaultArgs = (profile.defaultArgs ?? []).filter((arg) => !baseArgs.includes(arg));
  const modelArgs =
    profile.modelFlag && profile.defaultModel && !baseArgs.includes(profile.modelFlag)
      ? [profile.modelFlag, profile.defaultModel]
      : [];
  const configArgs = Object.entries(profile.defaultConfig ?? {}).flatMap(([key, value]) =>
    hasConfigOverride(baseArgs, key) ? [] : ["-c", `${key}=${value}`]
  );
  const mcpArgs = profile.mcpArgs && mcp && !baseArgs.includes("--mcp-config") ? profile.mcpArgs(mcp) : [];
  const primeArgs =
    profile.systemPromptFlag && prime ? [profile.systemPromptFlag, profile.systemPromptValue?.(prime) ?? prime] : [];
  return [...baseArgs, ...defaultArgs, ...modelArgs, ...configArgs, ...mcpArgs, ...primeArgs];
}

function hasConfigOverride(args: readonly string[], key: string): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-c" || arg === "--config") {
      const value = args[i + 1];
      if (value?.startsWith(`${key}=`)) return true;
      i++;
      continue;
    }
    if (arg.startsWith("-c") && arg.slice(2).trimStart().startsWith(`${key}=`)) return true;
    if (arg.startsWith("--config=") && arg.slice("--config=".length).startsWith(`${key}=`)) return true;
  }
  return false;
}

/**
 * Resolve a harness profile by name, falling back to the default. When an
 * unknown profile is requested we LOG (design §10) rather than silently guess.
 */
export function getProfile(name: string | undefined, onWarn?: (msg: string) => void): HarnessProfile {
  if (!name) return DEFAULT_PROFILE;
  const profile = PROFILES[name];
  if (!profile) {
    onWarn?.(`No harness profile "${name}"; using default rules.`);
    return DEFAULT_PROFILE;
  }
  return profile;
}

/**
 * Map a harness command to a profile name (extraction-contract §7.2). Uses the
 * command basename so `/usr/local/bin/claude` resolves like `claude` and Windows
 * npm shims such as `pi.cmd` resolve like `pi`. Unknown commands return
 * undefined → `getProfile` falls back to the default profile.
 */
export function commandProfileName(command: string): string | undefined {
  if (!command) return undefined;
  const base = command.trim().split(/[\\/]/).pop() ?? "";
  const normalized = base.replace(/\.(?:cmd|ps1|exe)$/i, "").toLowerCase();
  if (normalized === "claude") return "claude";
  if (normalized === "pi") return "pi";
  if (normalized === "codex") return "codex";
  return undefined;
}
