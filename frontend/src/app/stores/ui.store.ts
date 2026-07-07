import { create } from "zustand";
import { resetIntroTour, resetPowerTour } from "../core/tours";

/**
 * App-chrome UI state that several unrelated components drive but no single one
 * owns. The settings dialog is rendered by {@link Sidebar}, yet the board command
 * palette (#96) must open it too — rather than lift the flag to `App` and drill
 * it through both siblings, both read/set it here (parity with the other stores).
 *
 * `focusMode` (#131) is read by both `App` (hides the sidebar/control-hub chrome)
 * and the canvas island's visibility applier (dims cards outside the selected
 * cluster) — another cross-cutting flag with no single owner.
 *
 * `debugMode` (#219) is set from the settings dialog but read by the canvas
 * island (mounts the debug inspector overlay). It persists to localStorage like
 * the theme knobs — a developer flips it once and it stays on across reloads.
 * Guarded reads because this store is also imported by plain-Node tests.
 *
 * `activeTour` (#179) is owned by `TourProvider` (renders Joyride) but driven
 * from elsewhere — auto-start after boot, and the Settings dialog's "Replay"
 * button. Persistence (the `as:tour-*` flags) lives in `core/tours`, not here:
 * this is only the "a tour is running right now" session state.
 */

export type ActiveTour = "intro" | "power";

interface UiState {
  settingsOpen: boolean;
  focusMode: boolean;
  debugMode: boolean;
  activeTour: ActiveTour | null;
  /** Bumped on every tour (re)start — keys the Joyride mount so a replay remounts cleanly. */
  tourRunId: number;
}

const DEBUG_KEY = "ai-storm.debug";

function readDebugMode(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(DEBUG_KEY) === "1";
}

export const useUiStore = create<UiState>(() => ({
  settingsOpen: false,
  focusMode: false,
  debugMode: readDebugMode(),
  activeTour: null,
  tourRunId: 0
}));

export const ui = {
  openSettings: () => useUiStore.setState({ settingsOpen: true }),
  setSettingsOpen: (open: boolean) => useUiStore.setState({ settingsOpen: open }),
  setFocusMode: (focusMode: boolean) => useUiStore.setState({ focusMode }),
  toggleFocusMode: () => useUiStore.setState((s) => ({ focusMode: !s.focusMode })),
  setDebugMode: (debugMode: boolean) => {
    if (typeof localStorage !== "undefined") {
      if (debugMode) localStorage.setItem(DEBUG_KEY, "1");
      else localStorage.removeItem(DEBUG_KEY);
    }
    useUiStore.setState({ debugMode });
  },
  /** Start (or restart) the intro tour; a replay forgets the persisted outcome first. */
  startIntroTour: () => {
    resetIntroTour();
    useUiStore.setState((s) => ({ activeTour: "intro" as const, tourRunId: s.tourRunId + 1 }));
  },
  /** Start (or restart) the power tour — from the milestone prompt or Settings. */
  startPowerTour: () => {
    resetPowerTour();
    useUiStore.setState((s) => ({ activeTour: "power" as const, tourRunId: s.tourRunId + 1 }));
  },
  endTour: () => useUiStore.setState({ activeTour: null })
};
