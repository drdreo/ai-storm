/**
 * Prompt framing for the bidirectional canvas seam (#13).
 *
 * Pure, framework-agnostic templates that turn a flattened canvas selection into
 * an EDITABLE terminal prompt. The framed string is typed into the live PTY with
 * NO trailing newline, so the cursor lands at the end ready for the user to keep
 * typing or edit before they hit Enter to submit — the interactive seam #14/#15
 * build verbs on top of.
 *
 * Kept dependency-free (no Angular / BlockSuite) so it is unit-testable in the
 * plain Node vitest env.
 */

import type { SpecFormat } from "@ai-storm/shared";
import { normalizeKind } from "./idea-descriptors";

/**
 * The intent behind feeding a selection into the prompt — one per card verb
 * (#13 `discuss`; #15 `expand` / `challenge` / `find-risks`). Adding a verb is:
 * widen this union, add a matching {@link PROMPT_TEMPLATES} entry, and add a row
 * to `CARD_VERBS` in `canvas/CardVerbBar.tsx` (the Templates dropdown entry that
 * carries it, #195).
 */
export type PromptIntent = "discuss" | "expand" | "challenge" | "find-risks" | "combine";

/**
 * Frames a (trimmed, non-empty) selection into an editable prompt per intent.
 *
 * Invariant: every template ends with a TRAILING SPACE and NO trailing newline,
 * so the cursor lands ready for the user to type and nothing is auto-submitted.
 * Each verb scaffolds the AI move (#15) but leaves the final clause open, so the
 * user steers it before submitting — the whole point of the editable seam.
 */
export const PROMPT_TEMPLATES: Record<PromptIntent, (selection: string) => string> = {
  discuss: (selection) => `Regarding these notes from the canvas:\n\n${selection}\n\nLet's discuss: `,
  expand: (selection) =>
    `Expand on this idea from the canvas — flesh it out with detail, concrete examples, and next steps:\n\n${selection}\n\nMy angle: `,
  challenge: (selection) =>
    `Challenge this idea from the canvas — stress-test it for the strongest objections, then give me a refined, stronger version that addresses them and supersedes the original:\n\n${selection}\n\nPush hardest on: `,
  "find-risks": (selection) =>
    `Find the risks, failure modes, and hidden assumptions in this idea from the canvas:\n\n${selection}\n\nI'm most worried about: `,
  combine: (selection) =>
    `Combine these ideas from the canvas into ONE stronger, unified idea — synthesize their best elements, resolve overlaps and tensions, and produce a single refined idea that stands on its own and supersedes its sources:\n\n${selection}\n\nWhat matters most in the merge: `
};

/**
 * Frame a canvas selection into an editable terminal prompt.
 *
 * Returns `''` for an empty/whitespace-only selection (nothing to discuss);
 * otherwise applies the {@link PromptIntent}'s template to the trimmed selection.
 * The result intentionally has a trailing space and no trailing newline.
 *
 * When `sourceRef` is given (the short ref(s) of the card(s) the verb fired from,
 * idea-graph design §4/§5), a tagging directive is PREPENDED so the ideas this
 * turn produces come back linked to those cards — without disturbing the
 * trailing-space editable seam (the cursor stays at the very end). A single ref
 * is accepted as a bare string; the multi-select `combine` verb (#62) passes the
 * full array of selected source refs.
 */
export function framePrompt(
  selection: string,
  intent: PromptIntent = "discuss",
  sourceRef?: string | readonly string[]
): string {
  const trimmed = selection.trim();
  if (!trimmed) return "";
  const refs = sourceRef == null ? [] : typeof sourceRef === "string" ? [sourceRef] : sourceRef;
  const body = PROMPT_TEMPLATES[intent](trimmed);
  const directive = refs.length ? refDirective(refs, intent) : "";
  return directive ? `${directive}\n\n${body}` : body;
}

/**
 * The card facts {@link frameReference} folds into a reference block (#194) — a
 * structural subset of canonical `IdeaCard` (the #192 normalized
 * serializer), declared here so this module stays tldraw-import-free.
 */
export interface ReferencedIdea {
  ref: string | null;
  kind: string;
  title: string;
  body: string;
  starred?: boolean;
  done?: boolean;
  superseded?: boolean;
  score?: { impact: number; effort: number; confidence?: number };
}

/** One card's reference-block lines: `@ref [kind] Title (flags)` + the body. */
function referenceLine(card: ReferencedIdea): string {
  const ref = card.ref ? `@${card.ref} ` : "";
  const kind = normalizeKind(card.kind);
  const tag = kind ? `[${kind}] ` : "";
  const flags = [
    card.starred ? "★ marked" : "",
    card.done ? "✓ done" : "",
    card.superseded ? "superseded" : "",
    card.score ? `impact ${card.score.impact}/5 · effort ${card.score.effort}/5` : ""
  ].filter(Boolean);
  const suffix = flags.length ? ` (${flags.join(" · ")})` : "";
  const heading = `${ref}${tag}${card.title.trim()}${suffix}`.trim();
  const body = card.body?.trim();
  return body ? `${heading}\n${body}` : heading;
}

/**
 * Frame selected cards into a plain reference block (#194) — the verb-free
 * hand-off: unlike {@link framePrompt}, it carries NO preset intent and NO
 * tagging directive; it just puts the selection (led by each card's stable
 * `@ref`) in front of the agent and leaves the next prompt entirely to the
 * user. Same editable-seam invariant as the verb templates: trailing space, no
 * trailing newline, so nothing auto-submits and the cursor lands ready. Same
 * echo rule too: no literal `«…»` marker tokens (PD-008 — the screen is
 * scanned). Returns `''` for an empty list.
 */
export function frameReference(cards: readonly ReferencedIdea[]): string {
  const blocks = cards.map(referenceLine).filter((block) => block.trim());
  if (blocks.length === 0) return "";
  const example = cards.find((card) => card.ref)?.ref;
  const refHint = example ? ` (like @${example})` : "";
  return `Referenced canvas ideas:\n\n${blocks.join("\n\n")}\n\nUse the refs above${refHint} when discussing these ideas. `;
}

/**
 * Frame an AI triage request (#60): ask the agent to rate every card on the board
 * for impact / effort / confidence and reply with one score line per card.
 *
 * `board` is the ref-annotated serialization (`@a1 [feature] Title — body`, one
 * per line) from `serializeForTriage`. CRITICAL (same rule as {@link framePrompt}'s
 * directives): this text is typed into the terminal and echoed onto the screen,
 * which the backend scans for markers (PD-008). So it must NOT contain a literal
 * `«SCORE»`/`«IDEA»` token — the scoring-marker grammar is taught by the session
 * priming (system prompt), and this prompt only *refers* to it. Returns `''` for
 * an empty board. Unlike the verb prompts, this one is meant to be SUBMITTED (the
 * caller appends the carriage return), since it asks for a complete triage pass.
 */
export function frameTriage(board: string): string {
  const trimmed = board.trim();
  if (!trimmed) return "";
  return (
    `Triage the cards on my canvas below. Rate EACH card for impact, effort, and confidence — ` +
    `each an integer from 1 to 5 (higher impact = more valuable, higher effort = more costly, ` +
    `higher confidence = more sure). For every card, emit ONE score line in the scoring-marker ` +
    `format you were primed with, referencing that card's @ref, with nothing else on the line. ` +
    `Do not rewrite the cards as ideas.\n\n${trimmed}\n`
  );
}

/**
 * Per-format descriptors (#110) — the single source for the SpecPanel's picker
 * UI, the status-badge label, and the download filename, so the panel carries no
 * format-specific branching.
 */
export const SPEC_FORMATS: Record<SpecFormat, { label: string; description: string; fileSuffix: string }> = {
  prd: {
    label: "PRD",
    description: "A concise product requirements doc: overview, goals, non-goals, requirements, open questions.",
    fileSuffix: "prd"
  },
  plan: {
    label: "Implementation plan",
    description:
      "An ordered engineering plan: milestones, concrete steps with acceptance criteria, risks, testing strategy.",
    fileSuffix: "plan"
  },
  issues: {
    label: "GitHub issues",
    description: "Ready-to-file GitHub issues — one per work item, with title, body, and suggested labels.",
    fileSuffix: "issues"
  },
  tasks: {
    label: "Agent tasks",
    description: "Self-contained task prompts, each individually copy-pasteable into a coding agent.",
    fileSuffix: "tasks"
  }
};

/** Options threaded from the SpecPanel through {@link frameSpec} (#110). */
export interface SpecOptions {
  /**
   * `issues` format only: instruct the agent to actually run `gh issue create`
   * per issue (side effects are opt-in — off means ready-to-file drafts). The
   * tool permission is granted per-run by the backend's vetted `create-issues`
   * capability (#120), not by the project's global agent args; `gh` auth is
   * still the user's — the framing asks for a graceful drafts fallback when the
   * command can't create.
   */
  createIssues?: boolean;
}

/**
 * The rules every hand-off format shares: stay grounded in the cards, honor the
 * ★ keep-marks, and speak GitHub-flavored markdown.
 */
const SPEC_RULES =
  `Ground everything in the cards below — do not invent scope. Cards marked with a leading ★ are ` +
  `the user's keep-marks: treat them as priorities. Write GitHub-flavored markdown.`;

/**
 * Per-format request bodies (#110). Each opens with what to turn the board into
 * and closes with what to output — {@link frameSpec} appends {@link SPEC_RULES}
 * and the board itself.
 */
const SPEC_BODIES: Record<SpecFormat, (opts: SpecOptions) => string> = {
  prd: () =>
    `Turn the brainstorm board below into a concise PRD ready to hand to a coding agent. ` +
    `Use these sections: Overview, Goals, Non-goals, Requirements, and Open questions. ` +
    `Output only the PRD markdown, nothing else.`,
  plan: () =>
    `Turn the brainstorm board below into an ordered implementation plan ready to hand to a coding ` +
    `agent. Structure it as: milestones, then concrete steps each with acceptance criteria, then ` +
    `risks and unknowns, then a testing strategy. Output only the plan markdown, nothing else.`,
  issues: ({ createIssues }) =>
    createIssues
      ? `Turn the brainstorm board below into GitHub issues and CREATE them: for each work item, run ` +
        `\`gh issue create\` in the current working directory with a clear title, a well-structured ` +
        `body, and suggested labels. Each card below is tagged with a bracketed ref like [@a1]; end ` +
        `every created issue's body with a line \`Origin: ai-storm card @a1\` naming the ref(s) of the ` +
        `card(s) it came from. When done, output ONLY a summary of what was created — a table with one ` +
        `row per issue: title, URL, and the source card ref(s). If \`gh\` is unavailable or ` +
        `unauthorized, fall back to outputting the issues as ready-to-file drafts (one \`##\` section ` +
        `per issue: title, body, suggested labels), prefixed with a one-line explanation of why they ` +
        `were not created.`
      : `Turn the brainstorm board below into a set of ready-to-file GitHub issues — draft them, do ` +
        `NOT create them. Output one \`##\` section per issue containing the issue title, a ` +
        `well-structured body, and suggested labels. Output only the issues markdown, nothing else.`,
  tasks: () =>
    `Turn the brainstorm board below into a set of self-contained task prompts for coding agents. ` +
    `Output one \`##\` section per task, each individually copy-pasteable on its own: the context ` +
    `the agent needs, the task itself, constraints, and acceptance criteria. Output only the task ` +
    `prompts markdown, nothing else.`
};

/**
 * Frame a spec hand-off request (#89, PD-015; formats #110) — the convergence
 * step that closes the brainstorm → structure → hand-off loop (PRD §2). `board`
 * is the lifecycle-aware hand-off serialization (`handoffCardsToText`): superseded
 * ghosts already dropped, keep-marks already flagged with ★. The framed payload is
 * piped to the downstream orchestrator subprocess on stdin (PD-007 /
 * `agent.generateSpec`), NOT the live PTY — so, unlike the verb prompts and
 * {@link frameTriage}, it is a complete request with no editable trailing seam and
 * no marker-echo concern. `format` picks the {@link SPEC_BODIES} body (default
 * `'prd'` keeps the original contract); the shared {@link SPEC_RULES} apply to all.
 * Returns `''` for an empty board (nothing to hand off).
 */
export function frameSpec(board: string, format: SpecFormat = "prd", opts: SpecOptions = {}): string {
  const trimmed = board.trim();
  if (!trimmed) return "";
  return `${SPEC_BODIES[format](opts)} ${SPEC_RULES}\n\n${trimmed}\n`;
}

/**
 * A directive (idea-graph design §5) telling the agent how to link the ideas
 * this turn produces back to the source card, so the backend parses the link
 * and the canvas draws a connector. Prepended (never appended) so the verb's
 * open clause and the cursor stay at the very end.
 *
 * The relation depends on the verb (PD-012): {@link combineDirective} for
 * `combine` (the merged idea *replaces* all its sources — a fan of `supersedes`
 * edges, #62); {@link supersedeDirective} for `challenge` (the refined idea
 * *replaces* the single source); {@link aboutDirective} for every other verb
 * (the idea is simply *about* it).
 *
 * CRITICAL: no directive may contain the `«IDEA»` marker token. The directive is
 * typed into the terminal and echoed onto the screen, and the backend scans every
 * screen line for markers (PD-008 — it deliberately does NOT try to isolate the
 * agent's reply region). A literal marker here is echoed and re-extracted as a
 * bogus card. The marker grammar (including the `@ref` and `!` forms) is taught
 * instead by the session priming, which is delivered as a system prompt and never
 * echoed. So a directive only ever supplies the *ref(s)*.
 */
function refDirective(sourceRefs: readonly string[], intent: PromptIntent): string {
  if (intent === "combine") return combineDirective(sourceRefs);
  // The single-card verbs always carry exactly one ref; the first is the source.
  if (intent === "challenge") return supersedeDirective(sourceRefs[0]);
  return aboutDirective(sourceRefs[0]);
}

/**
 * Generic `about`-link directive (#42): supplies the source ref so the agent
 * links the ideas it captures back to this card (priming already tells it to
 * append a given ref to the marker → `{ to, relation: 'about' }`). No `«IDEA»`
 * token — see {@link refDirective}.
 */
function aboutDirective(sourceRef: string): string {
  return (
    `(These notes are from card @${sourceRef}. Tag EVERY idea you emit this turn by appending ` +
    `@${sourceRef} to its marker tag (right after the kind), so they all link back to this card. ` +
    `Do NOT add a trailing ! after the ref — that means "replace", which is not what you're doing here.)`
  );
}

/**
 * Challenge-as-supersede directive (PD-012): supplies the ref AND asks for the
 * `supersedes` relation via the `@ref!` form (priming defines what `!` means).
 * The refined, stronger version replaces the original, which recedes to a grey
 * ghost — history kept. No `«IDEA»` token — see {@link refDirective}.
 */
function supersedeDirective(sourceRef: string): string {
  return (
    `(This challenges card @${sourceRef}. Capture your refined, stronger version as a single idea and ` +
    `link it back as a REPLACEMENT using the @${sourceRef}! form — the trailing ! right after the ref — ` +
    `so it supersedes the original rather than just relating to it.)`
  );
}

/**
 * Combine-as-supersede directive (#62): the multi-select merge verb. Supplies
 * every selected source ref AND asks the agent to emit a SINGLE merged idea that
 * supersedes them all — via the chained `@a1!@a2!@a3!` form (each ref followed by
 * `!`, all appended to the one marker; the priming teaches this chain). The
 * sources fold into the merge and recede to grey ghosts (PD-012), history kept.
 * No `«IDEA»` token — see {@link refDirective}.
 */
function combineDirective(sourceRefs: readonly string[]): string {
  const list = sourceRefs.map((r) => `@${r}`).join(", ");
  const chain = sourceRefs.map((r) => `@${r}!`).join("");
  return (
    `(Combine cards ${list} into ONE stronger idea. Capture the merged result as a SINGLE idea — its ` +
    `description can run to a few sentences, since it synthesizes several cards, so don't force it into one ` +
    `line — and link it back as a REPLACEMENT of every source by chaining their refs on its marker as ` +
    `${chain} — each ref followed by a ! and appended directly after the previous — so the merged idea ` +
    `supersedes them all.)`
  );
}
