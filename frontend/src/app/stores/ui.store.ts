import { create } from "zustand";

/**
 * App-chrome UI state that several unrelated components drive but no single one
 * owns. The settings dialog is rendered by {@link Sidebar}, yet the board command
 * palette (#96) must open it too — rather than lift the flag to `App` and drill
 * it through both siblings, both read/set it here (parity with the other stores).
 *
 * `focusMode` (#131) is read by both `App` (hides the sidebar/control-hub chrome)
 * and the canvas island's visibility applier (dims cards outside the selected
 * cluster) — another cross-cutting flag with no single owner.
 */
interface UiState {
  settingsOpen: boolean;
  focusMode: boolean;
}

export const useUiStore = create<UiState>(() => ({
  settingsOpen: false,
  focusMode: false
}));

export const ui = {
  openSettings: () => useUiStore.setState({ settingsOpen: true }),
  setSettingsOpen: (open: boolean) => useUiStore.setState({ settingsOpen: open }),
  setFocusMode: (focusMode: boolean) => useUiStore.setState({ focusMode }),
  toggleFocusMode: () => useUiStore.setState((s) => ({ focusMode: !s.focusMode }))
};
