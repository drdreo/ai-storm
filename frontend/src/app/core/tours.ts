/**
 * Guided-tour catalogs and gating (#179). Pure data + pure functions so the
 * decision logic ("should the intro tour auto-start?") is unit-testable in the
 * node vitest environment — no Joyride, no DOM. The rendering side lives in
 * {@link ../components/TourProvider}.
 *
 * Persistence uses the app's `as:` localStorage prefix:
 *   - `as:tour-intro`  — `"done"` (finished) | `"dismissed"` (skipped/closed)
 *   - `as:tours`       — `"off"` kills all auto-start/prompt behavior; the e2e
 *                        suite sets this so tours never interfere with specs.
 *                        Replays from Settings still work — the switch only
 *                        gates *unprompted* tour starts.
 */

export const TOURS_KILL_SWITCH_KEY = "as:tours";
export const INTRO_TOUR_KEY = "as:tour-intro";

export type TourFlag = "done" | "dismissed";

/** The persisted inputs the gating functions decide on. */
export interface TourGates {
  /** Raw `as:tours` value; `"off"` disables all auto-start behavior. */
  killSwitch: string | null;
  /** Raw `as:tour-intro` value; any non-null value means "already seen". */
  intro: string | null;
}

/** Read the gates from localStorage (guarded — core is also imported by node tests). */
export function readTourGates(): TourGates {
  if (typeof localStorage === "undefined") return { killSwitch: "off", intro: null };
  return {
    killSwitch: localStorage.getItem(TOURS_KILL_SWITCH_KEY),
    intro: localStorage.getItem(INTRO_TOUR_KEY)
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

/** Record the intro tour's outcome so it never auto-starts again. */
export function markIntroTour(flag: TourFlag): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(INTRO_TOUR_KEY, flag);
}

/** Forget the intro tour outcome (Settings "Replay" resets before starting). */
export function resetIntroTour(): void {
  if (typeof localStorage !== "undefined") localStorage.removeItem(INTRO_TOUR_KEY);
}

/**
 * One tour step as pure data. `target` is a CSS selector against the stable
 * `data-tour` anchors (Tailwind class names are not selectable); `placement`
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
    content:
      "An open canvas for you and the agent to think together. Press i to drop an idea card anywhere.",
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
