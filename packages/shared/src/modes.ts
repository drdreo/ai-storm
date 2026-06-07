/**
 * Facilitation modes (#61) — swappable agent priming presets that change *how*
 * the agent ideates, layered on top of the base `«IDEA»`-contract priming.
 *
 * A mode is just a named priming template (`prime`) appended to the base
 * contract instruction the backend already sends on session create
 * (`docs/design/ai-response-extraction-contract.md` §4). It introduces no new
 * extraction, no new wire types, and no new card kinds — the `«IDEA»`/`«SCORE»`
 * grammar is invariant across modes; only the preamble that steers the agent's
 * style changes. This catalog is the single source of truth shared by the
 * backend (which appends `prime` to the launch system-prompt) and the frontend
 * (which renders the picker from `label`/`hint`).
 *
 * Because priming is baked into the harness launch (system-prompt flag), the
 * selected mode takes effect when a session is (re)started — switching mode
 * starts a fresh session rather than re-priming a live one.
 */

/** A selectable facilitation method. */
export interface FacilitationMode {
  /** Stable id persisted in the workspace config and sent on `attach`. */
  id: string;
  /** Human label shown in the mode picker. */
  label: string;
  /** One-line hint shown beside the picker describing the mode. */
  hint: string;
  /**
   * Priming preset appended to the base `«IDEA»`-contract instruction. Empty for
   * the default free-form mode (base contract only, today's behaviour).
   */
  prime: string;
}

/** The default mode: base contract only, no facilitation preset (status quo). */
export const DEFAULT_MODE_ID = "free";

/**
 * The catalog, in picker order. The first entry is the default. Each `prime`
 * keeps the `«IDEA»` contract intact and only steers *how* ideas are generated.
 */
export const FACILITATION_MODES: readonly FacilitationMode[] = [
  {
    id: "free",
    label: "Free-form",
    hint: "type directly — ideas land on the canvas",
    prime: "",
  },
  {
    id: "scamper",
    label: "SCAMPER",
    hint: "work the topic through each SCAMPER lens",
    prime:
      "FACILITATION MODE — SCAMPER. Drive ideation with the SCAMPER lenses: " +
      "Substitute, Combine, Adapt, Modify (magnify/minify), Put to another use, " +
      "Eliminate, Reverse. Work the topic through each lens in turn and emit the " +
      "ideas each lens provokes as «IDEA» lines — you may name the lens in the " +
      'title (e.g. "Substitute: …").',
  },
  {
    id: "six-hats",
    label: "Six Hats",
    hint: "examine the topic from all six thinking hats",
    prime:
      "FACILITATION MODE — Six Thinking Hats. Examine the topic from each of de " +
      "Bono's six hats: White (facts/data), Red (feelings/intuition), Black " +
      "(risks/caution), Yellow (benefits/optimism), Green (creativity/alternatives), " +
      "Blue (process/overview). Move hat by hat and capture what each surfaces as " +
      "«IDEA» lines, tagging the kind where it fits (Black → «IDEA:risk», a Blue " +
      "summary → «IDEA:decision»).",
  },
  {
    id: "crazy-8s",
    label: "Crazy-8s",
    hint: "eight fast, divergent ideas before refining",
    prime:
      "FACILITATION MODE — Crazy-8s. Generate ideas fast and in volume: aim for " +
      "eight distinct, divergent ideas in quick succession before refining any of " +
      "them. Favour quantity and range over polish, and emit each as its own " +
      "«IDEA» line. Don't self-censor — wild ideas are welcome.",
  },
  {
    id: "yes-and",
    label: "Yes-and",
    hint: "accept each idea and build on it",
    prime:
      "FACILITATION MODE — Yes-and. Build improvisationally: accept each idea " +
      "(yours or the user's) and extend it rather than blocking it. When you build " +
      "on an existing card, link your additive idea to it with its @ref so the " +
      "build chain is visible on the canvas. Keep momentum — every turn should " +
      "accept and add.",
  },
];

/** Look up a mode by id, falling back to the default if absent/unknown. */
export function getFacilitationMode(id: string | undefined): FacilitationMode {
  return FACILITATION_MODES.find((m) => m.id === id) ?? FACILITATION_MODES[0];
}
