/**
 * Guided-tour catalogs and gating (#179). Pure data + pure functions so the
 * decision logic ("should the intro tour auto-start?") is unit-testable in the
 * node vitest environment — no Joyride, no DOM. The rendering side lives in
 * {@link ../components/TourProvider}.
 *
 * Persistence uses the app's `as:` localStorage prefix:
 *   - `as:tour-intro`  — `"done"` (finished) | `"dismissed"` (skipped/closed)
 *   - `as:tour-power`  — same values; `"dismissed"` also records declining the
 *                        milestone prompt, so the offer is strictly one-shot
 *   - `as:tours`       — `"off"` kills all auto-start/prompt behavior; the e2e
 *                        suite sets this so tours never interfere with specs.
 *                        Replays from Settings still work — the switch only
 *                        gates *unprompted* tour starts.
 */

export const TOURS_KILL_SWITCH_KEY = "as:tours";
export const INTRO_TOUR_KEY = "as:tour-intro";
export const POWER_TOUR_KEY = "as:tour-power";

/** Board size at which the power tour becomes worth offering (#179). */
export const POWER_TOUR_MIN_CARDS = 5;

export type TourFlag = "done" | "dismissed";

/** The persisted inputs the gating functions decide on. */
export interface TourGates {
  /** Raw `as:tours` value; `"off"` disables all auto-start behavior. */
  killSwitch: string | null;
  /** Raw `as:tour-intro` value; any non-null value means "already seen". */
  intro: string | null;
  /** Raw `as:tour-power` value; any non-null value means "already offered". */
  power: string | null;
}

/** Read the gates from localStorage (guarded — core is also imported by node tests). */
export function readTourGates(): TourGates {
  if (typeof localStorage === "undefined") return { killSwitch: "off", intro: null, power: null };
  return {
    killSwitch: localStorage.getItem(TOURS_KILL_SWITCH_KEY),
    intro: localStorage.getItem(INTRO_TOUR_KEY),
    power: localStorage.getItem(POWER_TOUR_KEY)
  };
}

/**
 * Whether the intro tour should auto-start on this launch: only when tours
 * aren't globally off and the user has never finished *or* dismissed it —
 * both outcomes count as "seen"; the tour must never auto-start twice.
 */
export function shouldOfferIntro(gates: TourGates): boolean {
  return gates.killSwitch !== "off" && gates.intro === null;
}

/** The live session facts the power-tour milestone is judged on. */
export interface PowerTourMilestone {
  /** A PTY session is attached to the active project. */
  attached: boolean;
  /** Idea cards currently on the active board. */
  cardCount: number;
}

/**
 * Whether to show the one-shot "Take the power tour?" prompt: tours not
 * globally off, the power tour never offered before (taking, skipping, or
 * declining the prompt all persist), and the user has actually produced a
 * board worth the features — a live session plus ≥{@link POWER_TOUR_MIN_CARDS}
 * cards. It never auto-runs; the prompt only offers.
 */
export function shouldOfferPower(gates: TourGates, milestone: PowerTourMilestone): boolean {
  return (
    gates.killSwitch !== "off" &&
    gates.power === null &&
    milestone.attached &&
    milestone.cardCount >= POWER_TOUR_MIN_CARDS
  );
}

/** Record the intro tour's outcome so it never auto-starts again. */
export function markIntroTour(flag: TourFlag): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(INTRO_TOUR_KEY, flag);
}

/** Forget the intro tour outcome (Settings "Replay" resets before starting). */
export function resetIntroTour(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(INTRO_TOUR_KEY);
}

/** Record the power tour's outcome (or a declined milestone prompt). */
export function markPowerTour(flag: TourFlag): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(POWER_TOUR_KEY, flag);
}

/** Forget the power tour outcome (Settings "Replay" resets before starting). */
export function resetPowerTour(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(POWER_TOUR_KEY);
}

/**
 * One tour step as pure data. `target` is a CSS selector against a stable
 * anchor — our own `data-tour` attributes, or a `data-testid` tldraw ships on
 * its native chrome (Tailwind class names are not selectable); `placement`
 * mirrors Joyride's — `"center"` renders an unanchored, centered tooltip for
 * steps that teach a keyboard-only surface with no chrome to spotlight.
 */
export interface TourStepData {
  target: string;
  title: string;
  content: string;
  placement: "top" | "bottom" | "left" | "right" | "center";
  /**
   * Skip the dimmed overlay + spotlight for this step. The canvas step must
   * coexist with the `CanvasEmptyState` overlay on a fresh board — the tour
   * teaches the chrome, the empty state owns the canvas center, so the tour
   * must not dim or spotlight the canvas interior.
   */
  hideOverlay?: boolean;
}

/**
 * Intro tour (~5 steps): the three structural surfaces and the first move.
 * Feature depth (verb bar, triage, filters, …) belongs to the power tour.
 */
export const INTRO_TOUR_STEPS: readonly TourStepData[] = [
  {
    target: '[data-tour="sidebar"]',
    title: "Projects live here",
    content:
      "Each project is its own board and session. Create, rename, and organize them into folders from the sidebar.",
    placement: "right"
  },
  {
    target: '[data-tour="canvas"]',
    title: "Your board",
    content: "An open canvas for you and the agent to think together. Press i to drop an idea card anywhere.",
    placement: "bottom",
    hideOverlay: true
  },
  {
    target: '[data-tour="control-hub"]',
    title: "The control hub",
    content:
      "Pick a working directory and harness, then hit Start session — the agent's ideas land on the board as cards.",
    placement: "left"
  },
  {
    target: "body",
    title: "The command palette",
    content:
      "Ctrl/⌘ K finds every action — arrange, filter, summarize, export. If you remember one thing, remember this.",
    placement: "center"
  },
  {
    target: '[data-tour="settings"]',
    title: "Settings",
    content: "Appearance knobs live here — and you can replay these tours any time.",
    placement: "right"
  }
];

/**
 * Power tour (~7 steps): the feature verbs a working board earns. Offered by
 * the milestone prompt ({@link shouldOfferPower}), never auto-run. Steps that
 * teach state- or keyboard-only surfaces (the verb bar needs a selected card,
 * focus mode is a shortcut) are centered rather than gated on user state.
 */
export const POWER_TOUR_STEPS: readonly TourStepData[] = [
  {
    target: "body",
    title: "The card verb bar",
    content:
      "Select any card and a verb bar appears: Discuss, Expand, Challenge, Combine — each hands the card to the agent with that intent.",
    placement: "center"
  },
  {
    target: '[data-tour="triage"]',
    title: "Triage",
    content: "The agent scores every idea on the board — impact, effort, and confidence — right on the cards.",
    placement: "bottom"
  },
  // The Arrange/Filter steps spotlight tldraw's native main menu (top-left ☰)
  // where those submenus actually live — targeted via tldraw's own stable
  // test id, since we can't put a data-tour attribute on its internals.
  {
    target: '[data-testid="main-menu.button"]',
    title: "Arrange layouts",
    content:
      "This board menu holds Arrange: lay the board out as a mind map, or as a priority grid — which pairs with triage scores.",
    placement: "right"
  },
  {
    target: '[data-testid="main-menu.button"]',
    title: "Filters",
    content:
      "The same menu holds Filter: show only marked, triaged, AI, or user cards; hide kinds or superseded ideas — and clear it all in one click.",
    placement: "right"
  },
  {
    target: '[data-tour="summarize"]',
    title: "Summarize & Stats",
    content: "Converge the board into themes with Summarize; Stats shows counts, kinds, and the generation timeline.",
    placement: "bottom"
  },
  {
    target: '[data-tour="export"]',
    title: "Export to format",
    content:
      "Hand the board off as a PRD, GitHub issues, or agent tasks. Past runs — summaries, triages, exports — live in History.",
    placement: "bottom"
  },
  {
    target: "body",
    title: "Focus mode",
    content: "Ctrl/⌘ Shift F hides all chrome for a distraction-free view of the selected cluster. Escape exits.",
    placement: "center"
  }
];
