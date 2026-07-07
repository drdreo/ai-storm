/**
 * Guided-tour host (#179). Mounted once in `App` after boot; renders Joyride
 * (v3) for whichever tour `ui.store.activeTour` says is running and owns the
 * auto-start decision + outcome persistence. The step catalogs and gating live
 * in `core/tours` as pure data so they stay node-testable.
 *
 * Two tours, two triggers:
 *   - **intro** — auto-starts on the first launch (flag unset, kill switch off).
 *   - **power** — never auto-runs; once a session is attached and the board has
 *     earned it (≥5 cards), a one-shot toast offers it. Declining is persisted.
 *
 * Theming: the tooltip is colored entirely through the app's CSS variables
 * (`--popover`, `--primary`, `--radius`, …) so it follows every appearance
 * knob — mode, palette, radius, contrast — without tour-specific styling.
 */
import { useEffect, useState } from "react";
import { Joyride, EVENTS, STATUS, type EventData, type Step } from "react-joyride";
import { Button } from "@/components/ui/button";
import {
  INTRO_TOUR_STEPS,
  POWER_TOUR_STEPS,
  markIntroTour,
  markPowerTour,
  readTourGates,
  shouldOfferIntro,
  shouldOfferPower,
  type TourStepData
} from "../core/tours";
import { canvas, useCanvasStore } from "../stores/canvas.store";
import { useIngestionStore } from "../stores/ingestion.store";
import { useProjectStore } from "../stores/project.store";
import { ui, useUiStore, type ActiveTour } from "../stores/ui.store";

function toJoyrideSteps(steps: readonly TourStepData[]): Step[] {
  return steps.map((s) => ({
    target: s.target,
    title: s.title,
    content: s.content,
    placement: s.placement,
    hideOverlay: s.hideOverlay ?? false
  }));
}

const STEPS: Record<ActiveTour, Step[]> = {
  intro: toJoyrideSteps(INTRO_TOUR_STEPS),
  power: toJoyrideSteps(POWER_TOUR_STEPS)
};

const MARK: Record<ActiveTour, (flag: "done" | "dismissed") => void> = {
  intro: markIntroTour,
  power: markPowerTour
};

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

/**
 * The one-shot power-tour offer. Rendered (not auto-running the tour) so the
 * user opts in; either answer resolves the offer permanently — "No thanks"
 * persists a dismissal, taking the tour persists its outcome on exit.
 */
function PowerTourPrompt({ onTake, onDecline }: { onTake: () => void; onDecline: () => void }) {
  return (
    <div
      role="status"
      aria-label="Power tour offer"
      className="fixed bottom-4 right-4 z-50 flex max-w-xs flex-col gap-3 rounded-lg border bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <div className="grid gap-1">
        <span className="text-sm font-semibold">Take the power tour?</span>
        <span className="text-xs text-muted-foreground">
          Your board is rolling — see triage, layouts, filters, and hand-off in 7 quick steps.
        </span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDecline}>
          No thanks
        </Button>
        <Button size="sm" onClick={onTake}>
          Show me
        </Button>
      </div>
    </div>
  );
}

export function TourProvider() {
  const activeTour = useUiStore((s) => s.activeTour);
  const tourRunId = useUiStore((s) => s.tourRunId);
  const activeId = useProjectStore((s) => s.activeId);
  const attached = useIngestionStore((s) => (activeId ? !!s.attached[activeId] : false));
  const ideasTick = useCanvasStore((s) => s.ideasTick);
  const [powerPrompt, setPowerPrompt] = useState(false);

  // First-launch auto-start: only when the flag is unset and `as:tours` isn't
  // "off" (the e2e kill switch). Replays from Settings bypass this gate.
  useEffect(() => {
    if (shouldOfferIntro(readTourGates())) ui.startIntroTour();
  }, []);

  // Power-tour milestone watch: re-judged whenever the board (`ideasTick`) or
  // the session changes. `shouldOfferPower` is one-shot by construction — any
  // persisted `as:tour-power` value blocks it — so this can run hot without
  // ever re-offering; the card walk only happens while the offer is still open.
  useEffect(() => {
    if (powerPrompt || activeTour || !attached || !activeId) return;
    const gates = readTourGates();
    if (gates.power !== null || gates.killSwitch === "off") return;
    const { cardCount } = canvas.boardCommandState(activeId);
    if (shouldOfferPower(gates, { attached, cardCount })) setPowerPrompt(true);
  }, [ideasTick, attached, activeId, activeTour, powerPrompt]);

  return (
    <>
      {powerPrompt && !activeTour && (
        <PowerTourPrompt
          onTake={() => {
            setPowerPrompt(false);
            ui.startPowerTour();
          }}
          onDecline={() => {
            setPowerPrompt(false);
            markPowerTour("dismissed");
          }}
        />
      )}
      {activeTour && (
        <Joyride
          key={`${activeTour}-${tourRunId}`}
          run
          continuous
          steps={STEPS[activeTour]}
          onEvent={(data: EventData) => {
            if (data.type !== EVENTS.TOUR_END) return;
            // Finishing and skipping both count as "seen" — never offer again.
            MARK[activeTour](data.status === STATUS.FINISHED ? "done" : "dismissed");
            ui.endTour();
          }}
          options={OPTIONS}
          styles={STYLES}
          locale={{ last: "Done" }}
        />
      )}
    </>
  );
}
