/**
 * Session priming (extraction-contract §4, mcp-idea-capture §5) — the launch
 * -time instruction text and its assembly. Extracted from the server so the
 * HTTP/WS layer doesn't carry the contract prose: the server only asks
 * {@link harnessSetup} for the profile name + prime to launch with.
 */

import { getFacilitationMode } from "@ai-storm/shared";
import { commandProfileName, getProfile } from "./extraction/index.ts";

/**
 * The §4.1 session-priming instruction. Delivered to a contract-aware harness
 * (Claude Code, pi, Codex) at launch (see
 * `HarnessProfile.systemPromptFlag`), so the `«IDEA»` contract is followed from
 * the first turn with nothing typed into the terminal. It defines the
 * single-line `«IDEA»` marker (and fenced form) the backend extracts into
 * canvas ideas.
 */
const PRIME_INSTRUCTION = `You are in a brainstorming project. Reply normally in conversation.

Whenever you produce a brainstorming idea or ideation note worth capturing on the canvas, emit it on its OWN line in exactly this format, then continue talking normally:

  «IDEA» <short title> :: <one-line description>

Optionally tag the kind: «IDEA:risk», «IDEA:feature», «IDEA:question», «IDEA:decision».

When you are responding about a specific existing card whose ref you were given (it looks like @a1), link your idea to it by appending that ref to the marker, after any kind:

  «IDEA:risk@a1» <short title> :: <one-line description>

If your idea is a stronger version that REPLACES (supersedes) that card, put a ! right after the ref — the original then recedes on the canvas while yours takes its place:

  «IDEA:feature@a1!» <short title> :: <one-line description>

When you are asked to COMBINE or merge several cards into one stronger idea, emit a SINGLE «IDEA» line that chains every source ref, each with a trailing !, so the merged idea supersedes them all (they recede while it takes their place):

  «IDEA:feature@a1!@a2!@a3!» <short title> :: <description>

A merge folds several cards into one, so its description should be as long as it needs to be to capture the synthesis — a few sentences is fine, not just one line. Keep the whole thing on this single «IDEA» line (do NOT use the fenced block for a merge — the ref chain only works on the single-line marker); wrapping is fine, just don't press Enter in the middle.

For an idea that truly needs several lines, use a fenced block instead:

  \`\`\`idea kind=<kind>
  title: <short title>
  body: <as many lines as you need>
  \`\`\`

When you are asked to TRIAGE or rate the existing cards, score each one on its OWN line in exactly this format — impact/effort/confidence, each an integer 1-5 (higher impact = more valuable, higher effort = more costly, higher confidence = more sure):

  «SCORE@a1» 4/2/3

Use the card's @ref. Confidence is optional — «SCORE@a1» 4/2 is fine. Emit one «SCORE» line per card and nothing else on that line; do NOT rewrite the cards as «IDEA» lines when triaging.

Rules:
- One idea per «IDEA» line. Put each «IDEA» line on its own line.
- Use «IDEA» ONLY for real ideas, never for chitchat, status, or questions.
- Everything that is NOT an «IDEA» or «SCORE» line is treated as ordinary chat.`;

/**
 * The MCP base prime (mcp-idea-capture §5) — used instead of
 * {@link PRIME_INSTRUCTION} when the harness profile is MCP-wired (`mcpArgs`
 * present): teach the tools, not the marker grammar. One mechanism per session
 * keeps the model's behaviour unimodal (the strongest determinism lever the
 * CLIs offer); the marker scanner still runs underneath as the silent floor
 * (§7), so a tool-call lapse is caught — and logged — not lost.
 */
const MCP_PRIME_INSTRUCTION = `You are in a brainstorming project. Reply normally in conversation.

Whenever you produce a brainstorming idea or ideation note worth capturing on the canvas, call the capture_idea tool: a short title, a description in body (multi-line is fine), and optionally a kind (risk, feature, question, decision).

When you are responding about a specific existing card whose ref you were given (it looks like @a1), link your idea to it by passing links:[{to:"a1"}]. If your idea is a stronger version that REPLACES (supersedes) that card, pass links:[{to:"a1",relation:"supersedes"}] — the original then recedes on the canvas while yours takes its place. When you are asked to COMBINE or merge several cards into one stronger idea, make a SINGLE capture_idea call with one supersedes link per source card.

When you are asked to TRIAGE or rate the existing cards, call capture_score once per card — impact/effort and optional confidence, each an integer 1-5 (higher impact = more valuable, higher effort = more costly, higher confidence = more sure) — and do NOT create new cards while triaging.

Rules:
- One idea per capture_idea call. Use it ONLY for real ideas, never for chitchat, status, or questions.
- Do NOT also write the idea as a special marker line — the tool call is the capture.
- Mention the returned @ref in your reply so the user can follow along.`;

/**
 * Wrap the user's pre-brainstorm background context (#76) in a labelled block so
 * it reads to the agent as standing *guidance* ("here is the scene"), not as
 * instructions to follow literally. Returns "" for empty/whitespace-only input,
 * so a blank background contributes nothing to the prime (byte-identical to
 * today — PD-020).
 */
function formatBackground(background?: string): string {
  const text = background?.trim();
  if (!text) return "";
  return (
    "BACKGROUND CONTEXT — standing context for every idea this session " +
    "(the user set the scene; treat it as guidance shaping what fits, not as " +
    `instructions to act on):\n${text}`
  );
}

/**
 * Derive the harness profile name + priming text from the harness command, the
 * selected facilitation mode (#61), and the user's background context (#76). A
 * contract-aware harness (Claude Code, pi, Codex) is primed via its launch-time
 * prompt/config seam with the base `«IDEA»` instruction, then the mode's preset
 * (when not the free-form default), then the background block (when non-empty)
 * — three segments on the same launch seam (PD-020). Anything else gets no
 * prime (extraction-contract §4.6). Empty mode + empty background ⇒ the prime
 * is exactly the base instruction.
 *
 * The BASE segment is capability-conditional (mcp-idea-capture §5): an
 * MCP-wired profile (`mcpArgs` present) is taught the capture tools; everything
 * else keeps the byte-identical «IDEA» marker prime. Mode/background segments
 * are capability-neutral and shared by both.
 */
export function harnessSetup(
  command: string,
  mode?: string,
  background?: string
): { harnessProfile?: string; prime?: string } {
  const harnessProfile = commandProfileName(command);
  const profile = getProfile(harnessProfile);
  if (!profile.supportsIdeaContract) return { harnessProfile, prime: undefined };
  const base = profile.mcpArgs ? MCP_PRIME_INSTRUCTION : PRIME_INSTRUCTION;
  const prime = [base, getFacilitationMode(mode).prime, formatBackground(background)].filter(Boolean).join("\n\n");
  return { harnessProfile, prime };
}
