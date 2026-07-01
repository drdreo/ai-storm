import { create } from 'zustand'

/**
 * App-chrome UI state that several unrelated components drive but no single one
 * owns. The settings dialog is rendered by {@link Sidebar}, yet the board command
 * palette (#96) must open it too — rather than lift the flag to `App` and drill
 * it through both siblings, both read/set it here (parity with the other stores).
 */
interface UiState {
  settingsOpen: boolean
}

export const useUiStore = create<UiState>(() => ({
  settingsOpen: false,
}))

export const ui = {
  openSettings: () => useUiStore.setState({ settingsOpen: true }),
  setSettingsOpen: (open: boolean) => useUiStore.setState({ settingsOpen: open }),
}
