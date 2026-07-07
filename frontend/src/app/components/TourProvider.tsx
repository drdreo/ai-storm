/**
 * Guided-tour host (#179). Mounted once in `App` after boot; renders Joyride
 * (v3) for whichever tour `ui.store.activeTour` says is running and owns the
 * auto-start decision + outcome persistence. The step catalogs and gating live
 * in `core/tours` as pure data so they stay node-testable.
 *
 * Theming: the tooltip is colored entirely through the app's CSS variables
 * (`--popover`, `--primary`, `--radius`, …) so it follows every appearance
 * knob — mode, palette, radius, contrast — without tour-specific styling.
 */
import { useEffect } from "react";
import { Joyride, EVENTS, STATUS, type EventData, type Step } from "react-joyride";
import { INTRO_TOUR_STEPS, markIntroTour, readTourGates, shouldOfferIntro } from "../core/tours";
import { ui, useUiStore } from "../stores/ui.store";

const INTRO_STEPS: Step[] = INTRO_TOUR_STEPS.map((s) => ({
  target: s.target,
  title: s.title,
  content: s.content,
  placement: s.placement,
  hideOverlay: s.hideOverlay ?? false
}));

/** Shared step options: theme via CSS vars, tooltip-first UX (no beacons). */
const OPTIONS = {
  arrowColor: "var(--popover)",
  backgroundColor: "var(--popover)",
  textColor: "var(--popover-foreground)",
  primaryColor: "var(--primary)",
  overlayColor: "oklch(0 0 0 / 0.5)",
  // Tooltips directly, no pulsing beacon between steps.
  skipBeacon: true,
  showProgress: true,
  // The X ends the whole tour (recorded as "dismissed") instead of Joyride's
  // default advance-to-next, and clicking the dim backdrop does nothing —
  // both would otherwise be surprising mid-tour exits into beacon mode.
  closeButtonAction: "skip" as const,
  overlayClickAction: false as const,
  // Above all app chrome: tailwind z-50 dialogs, and tldraw's UI layers —
  // the bottom toolbar sits in the hundreds and was intercepting clicks on
  // tooltips placed over the canvas.
  zIndex: 5000
};

const STYLES = {
  tooltip: {
    borderRadius: "calc(var(--radius) + 4px)",
    border: "1px solid var(--border)",
    padding: "1rem"
  },
  tooltipTitle: { fontSize: "0.875rem", fontWeight: 600 },
  tooltipContent: { fontSize: "0.8125rem", color: "var(--muted-foreground)", padding: "0.5rem 0 0" },
  buttonPrimary: { borderRadius: "var(--radius)", fontSize: "0.8125rem", padding: "0.375rem 0.75rem" },
  buttonBack: { color: "var(--muted-foreground)", fontSize: "0.8125rem" },
  buttonClose: { color: "var(--muted-foreground)" }
};

function onIntroEvent(data: EventData): void {
  if (data.type !== EVENTS.TOUR_END) return;
  // Finishing and skipping both count as "seen" — never auto-start again.
  markIntroTour(data.status === STATUS.FINISHED ? "done" : "dismissed");
  ui.endTour();
}

export function TourProvider() {
  const activeTour = useUiStore((s) => s.activeTour);
  const tourRunId = useUiStore((s) => s.tourRunId);

  // First-launch auto-start: only when the flag is unset and `as:tours` isn't
  // "off" (the e2e kill switch). Replays from Settings bypass this gate.
  useEffect(() => {
    if (shouldOfferIntro(readTourGates())) ui.startIntroTour();
  }, []);

  if (activeTour !== "intro") return null;
  return (
    <Joyride
      key={tourRunId}
      run
      continuous
      steps={INTRO_STEPS}
      onEvent={onIntroEvent}
      options={OPTIONS}
      styles={STYLES}
      locale={{ last: "Done" }}
    />
  );
}
