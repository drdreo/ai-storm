/**
 * Idea scanner (extraction-contract §3) — the robust 20% we keep after dropping
 * server-side chat extraction.
 *
 * The conversation surface is now a real terminal: raw PTY bytes are streamed to
 * the browser and rendered by xterm.js, so the fragile half — per-version chrome
 * regexes, echo anchoring, the "● " reply marker, response-completion detection
 * — is gone. All that remains here is scanning the rendered pane for the
 * explicit `«IDEA»` / ` ```idea ` markers we define via priming and emitting the
 * ideas they describe.
 *
 * The feature folder splits along its two concerns:
 *  - `harness.ts` — per-CLI profiles + launch-argv assembly (priming, model
 *    defaults, MCP wiring);
 *  - `markers.ts` — the contract grammar and pure scan functions, fed successive
 *    *captures* (the full, flattened text of the pane as it currently reads);
 *  - `scanner.ts` — the stateful layer: session-scoped dedupe sinks shared
 *    across producers, two-frame confirmation, near-miss diagnostics.
 *
 * Pure and runtime-free so it is unit-testable against recorded fixtures.
 */

export {
  CLAUDE_PROFILE,
  CODEX_PROFILE,
  DEFAULT_PROFILE,
  OPENCODE_PROFILE,
  PI_PROFILE,
  commandProfileName,
  computeFileLaunch,
  getProfile,
  launchArgsForProfile,
  profileUsesMcp,
  type FileLaunchContext,
  type FileLaunchResult,
  type HarnessProfile,
  type McpLaunchContext
} from "./harness.ts";
export { scanIdeas, scanScores } from "./markers.ts";
export { IdeaScanner, IdeaSink, ScoreScanner, ScoreSink } from "./scanner.ts";
export type { Idea, Score } from "@ai-storm/shared";
