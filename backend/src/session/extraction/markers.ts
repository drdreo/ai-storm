/**
 * Contract grammar + pure scan functions (extraction-contract §3, Appendix B —
 * single source of truth). This module knows how to recognise the `«IDEA»` /
 * ` ```idea ` / `«SCORE»` markers in a flattened pane capture and parse the
 * ideas/scores they describe. It is stateless: session-scoped dedupe and the
 * two-frame confirmation live in `./scanner.ts`.
 */

import type { CreateIdeaInput, IdeaLink, IdeaRelation, Score } from "@ai-storm/shared";

/**
 * `«IDEA[:kind][@ref[!]…]»` / `<<IDEA[:kind][@ref[!]…]>>` at line start. The
 * in-marker tag is `[:kind][@ref[!]…]` (idea-graph design §5.1): one or more
 * `@ref` tokens link this idea to the cards with those short refs; a trailing `!`
 * on a ref makes THAT link a `supersedes` (the idea REPLACES the target) instead
 * of the default `about`. Multiple chained refs (`@a1!@a2!`) let a single idea
 * supersede several sources — the multi-select `combine`/merge verb (#62). The
 * `!` form keeps `supersedes` on the robust single-line marker — the fenced
 * `rel:` key (below) is unreliable because the agent's TUI renders the code fence
 * away before the backend captures the screen (PD-008).
 * Groups: 1/3 = kind (guillemet/ASCII), 2/4 = the ref chain (`@a1!@a2`),
 * 5 = the remainder (`title :: body`). Individual refs are parsed from the chain
 * by {@link REF_TOKEN}.
 */
export const IDEA_MARKER =
  /^\s*(?:«IDEA(?::([a-z][\w-]*))?((?:@[\w-]+!?)+)?»|<<IDEA(?::([a-z][\w-]*))?((?:@[\w-]+!?)+)?>>)\s*(.*)$/u;
/** One `@ref` (with optional trailing `!`) within an {@link IDEA_MARKER} chain. */
const REF_TOKEN = /@([\w-]+)(!)?/gu;
/** ` ```idea [kind=…] ` opens a fenced (multi-line body) idea. */
const IDEA_FENCE_OPEN = /^\s*```idea(?:\s+kind=([a-z][\w-]*))?\s*$/u;
/** A bare ` ``` ` closes a fenced idea. */
const IDEA_FENCE_CLOSE = /^\s*```\s*$/;

/**
 * `«SCORE@ref» <impact>/<effort>[/<confidence>]` at line start (#60) — the AI
 * triage marker. Unlike `«IDEA»` it never creates a card: it carries a 1..5
 * impact/effort(/confidence) rating for the EXISTING card with that short ref.
 * Confidence is optional. The `@ref` is required — a score with no target is
 * meaningless. ASCII alias `<<SCORE@ref>>` accepted like the idea marker.
 * Groups: 1/2 = ref (guillemet/ASCII), 3 = impact, 4 = effort, 5 = confidence.
 */
const SCORE_MARKER = /^\s*(?:«SCORE@([\w-]+)»|<<SCORE@([\w-]+)>>)\s*([1-5])\s*\/\s*([1-5])(?:\s*\/\s*([1-5]))?\s*$/u;
/**
 * Fenced-body recognised keys (case-insensitive): title / body / kind, plus the
 * idea-graph keys id / link (alias parent) / rel (idea-graph design §5.1).
 */
const FENCE_KEY = /^(title|body|kind|id|link|parent|rel)\s*:\s*(.*)$/i;

/**
 * A line that LOOKS like an attempted idea marker but did not parse — used to
 * diagnose a contract-following lapse: mangled guillemets (`«IDEA »`, `?IDEA?`),
 * the bare word (`CreateIdeaInput: …`), bracketed (`[IDEA]`), or markdown-wrapped
 * (`**IDEA**`). Anchored at line start so a mid-sentence "idea" is not flagged,
 * and `\bidea\b` so "Ideally"/"ideas" don't trip it.
 */
export const MARKER_NEAR_MISS = /^\s*[^\w\s]{0,4}\s*idea\b/iu;

/**
 * Leading turn bullet that harnesses render on the FIRST row of an assistant
 * turn (`● <text>` in Claude Code, `• <text>` in Codex); subsequent rows carry
 * only a margin (already absorbed by the markers' `^\s*`). Stripped before
 * scanning so an idea the agent leads its reply with — `• «IDEA…»` — is still
 * anchored as a marker. Without this, only ideas that fall on a later
 * (margin-only) row are detected.
 */
export const TURN_BULLET = /^\s*[●•]\s+/u;

/**
 * Minimal, version-stable terminal furniture that BOUNDS an idea body when
 * rejoining word-wrapped rows: a box-drawing/blank rule, or a line that opens
 * with a prompt glyph (the input box sitting directly below the reply). This is
 * NOT the fragile per-version status-bar/spinner chrome we deleted — just enough
 * that the word-wrap rejoin never swallows the prompt that follows an idea.
 */
const CHROME_BOUNDARY = /^\s*(?:[─-╿\s]+|[>❯].*)$/u;

/** Coerce a relation token to a known {@link IdeaRelation}, else undefined. */
function parseRelation(value: string): IdeaRelation | undefined {
  const v = value.trim().toLowerCase();
  return v === "about" || v === "supersedes" ? v : undefined;
}

/**
 * Parse a single-line idea: `title :: body`, split on the FIRST `::`. Each in-marker
 * `@ref` in the chain becomes a link to that card (idea-graph §5.1) — `supersedes`
 * when that ref carried a trailing `!`, otherwise the default `about`. A chain of
 * supersede refs (`@a1!@a2!`) is the multi-select `combine` verb folding several
 * sources into one merged idea (#62).
 */
function ideaFromLine(kind: string | undefined, refChain: string | undefined, logical: string): CreateIdeaInput {
  const rest = logical.replace(IDEA_MARKER, "$5").trim(); // remainder after marker
  const sep = rest.indexOf("::");
  const title = (sep >= 0 ? rest.slice(0, sep) : rest).trim();
  const body = (sep >= 0 ? rest.slice(sep + 2) : "").trim();
  const idea: CreateIdeaInput = { title, body };
  if (kind) idea.kind = kind;
  const links = parseRefChain(refChain);
  if (links.length) idea.links = links;
  return idea;
}

/**
 * Split a marker ref chain (`@a1!@a2`) into typed links — one per `@ref`, each
 * `supersedes` if it carried a trailing `!`, else `about` (idea-graph §5.1).
 */
function parseRefChain(refChain: string | undefined): IdeaLink[] {
  if (!refChain) return [];
  const links: IdeaLink[] = [];
  for (const m of refChain.matchAll(REF_TOKEN)) {
    links.push({ to: m[1], relation: m[2] ? "supersedes" : "about" });
  }
  return links;
}

/**
 * Parse a fenced idea body. Recognised keys `title:`/`body:`/`kind:` seed the
 * fields; the first non-key line (with no key yet seen) is the title; every
 * line after `body:` (or every non-key line once a title exists) accumulates
 * verbatim into the body (extraction-contract §3.2 Form 2).
 */
function ideaFromFence(kind: string | undefined, rawBodyLines: string[]): CreateIdeaInput {
  let title: string | undefined;
  let kindV = kind;
  let id: string | undefined;
  let linkTo: string | undefined;
  let relation: IdeaRelation | undefined;
  const bodyParts: string[] = [];
  let inBody = false;

  // claude indents the whole assistant message (and thus the fenced block) by a
  // left margin, so trim each line before recognising the `key:` lines.
  const bodyLines = rawBodyLines.map((l) => l.trim());
  for (const line of bodyLines) {
    if (inBody) {
      bodyParts.push(line);
      continue;
    }
    const km = FENCE_KEY.exec(line);
    if (km) {
      const key = km[1].toLowerCase();
      const value = km[2].trim();
      switch (key) {
        case "title":
          title = value;
          break;
        case "kind":
          kindV = value || kindV;
          break;
        case "id":
          id = value || id;
          break;
        case "link":
        case "parent":
          linkTo = value || linkTo;
          break;
        case "rel":
          relation = parseRelation(value) ?? relation;
          break;
        default:
          // body:
          inBody = true;
          if (km[2].trim() !== "") bodyParts.push(km[2]);
          break;
      }
      continue;
    }
    // Non-key line: the first becomes the title, the rest spill into the body.
    if (title === undefined) title = line.trim();
    else {
      inBody = true;
      bodyParts.push(line);
    }
  }

  const finalTitle = (title ?? "").trim();
  const body = bodyParts.join("\n").trim();
  const idea: CreateIdeaInput = kindV ? { title: finalTitle, body, kind: kindV } : { title: finalTitle, body };
  if (id) idea.ref = id;
  if (linkTo) idea.links = [{ to: linkTo, relation: relation ?? "about" }];
  return idea;
}

/**
 * Scan a chrome-free region for idea markers and return the ideas it contains
 * (extraction-contract §3.3). When `final` is false, a still-growing tail (the
 * last marker line, or an unterminated fence) is held back so a half-rendered
 * idea is never emitted as a finished card — on the next capture the line is no
 * longer the tail and is emitted complete. The non-idea text is ignored: the
 * terminal already renders the conversation, so only ideas matter here.
 *
 * A single-line idea whose body word-wraps across several rows is rejoined: the
 * agent (and `capture-pane -J`) wrap at word boundaries, so the body continues
 * on the following non-blank, non-marker rows until a blank line / the next
 * marker — independent of pane width.
 */
export function scanIdeas(rawRegion: string[], final: boolean): CreateIdeaInput[] {
  const ideas: CreateIdeaInput[] = [];
  // Strip the claude turn bullet up front so every downstream check (marker
  // match, word-wrap rejoin, hold-back tail, near-miss) sees the same lines.
  const region = rawRegion.map((l) => l.replace(TURN_BULLET, ""));
  const n = region.length;

  // Index of the last non-blank line — the "growing tail" we hold back.
  let lastNonBlank = -1;
  for (let k = 0; k < n; k++) if (region[k].trim() !== "") lastNonBlank = k;

  let i = 0;
  while (i < n) {
    const line = region[i];

    // Form 2 — fenced block.
    const fence = IDEA_FENCE_OPEN.exec(line);
    if (fence) {
      const kind = fence[1];
      const bodyLines: string[] = [];
      let j = i + 1;
      while (j < n && !IDEA_FENCE_CLOSE.test(region[j])) bodyLines.push(region[j++]);
      const closed = j < n;
      if (!closed && !final) break; // open fence at the tail → hold back
      ideas.push(ideaFromFence(kind, bodyLines));
      i = closed ? j + 1 : n; // consume the closing fence (or the rest)
      continue;
    }

    // Form 1 — single-line marker, rejoining word-wrapped continuation rows.
    const m = IDEA_MARKER.exec(line);
    if (m) {
      const kind = m[1] ?? m[3];
      const refChain = m[2] ?? m[4];
      let logical = line;
      let k = i;
      // Absorb continuation rows until a blank line / next marker / fence /
      // terminal furniture (e.g. the input prompt directly below the reply).
      while (
        k + 1 < n &&
        region[k + 1].trim() !== "" &&
        !IDEA_MARKER.test(region[k + 1]) &&
        !IDEA_FENCE_OPEN.test(region[k + 1]) &&
        !CHROME_BOUNDARY.test(region[k + 1])
      ) {
        k++;
        logical += " " + region[k].trim(); // re-insert the space consumed at the wrap
      }
      if (!final && k >= lastNonBlank) break; // growing idea at the tail → hold back
      ideas.push(ideaFromLine(kind, refChain, logical));
      i = k + 1;
      continue;
    }

    // Non-idea line — ignored (the terminal renders the conversation itself).
    i++;
  }

  return ideas;
}

/**
 * Scan a region for `«SCORE@ref»` markers (#60) and return the scores they carry.
 * Each marker is a single, self-terminating line (no body to word-wrap), so —
 * unlike {@link scanIdeas} — there is no hold-back/rejoin: a SCORE line either
 * matches in full or is ignored. The `final` flag is accepted for call-site
 * symmetry but unused.
 */
export function scanScores(rawRegion: string[]): Score[] {
  const scores: Score[] = [];
  for (const raw of rawRegion) {
    const line = raw.replace(TURN_BULLET, "");
    const m = SCORE_MARKER.exec(line);
    if (!m) continue;
    const ref = m[1] ?? m[2];
    const score: Score = { ref, impact: Number(m[3]), effort: Number(m[4]) };
    if (m[5]) score.confidence = Number(m[5]);
    scores.push(score);
  }
  return scores;
}

/** Split a capture into lines and drop trailing blank lines (pane padding). */
export function toTrimmedLines(capture: string): string[] {
  const lines = capture
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
