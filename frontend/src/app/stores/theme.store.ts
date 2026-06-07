import { create } from 'zustand'

/**
 * App theme preference (#77) — a tiny global setting that controls the app's
 * light/dark palette *and* feeds tldraw's color scheme.
 *
 * `mode` is the user's *choice* ('system' follows the OS). It's persisted to
 * localStorage and applied to `<html>` by toggling the `.dark` class (the
 * selector our Tailwind/oklch variables key off, see `index.css`). An inline
 * boot script in `index.html` applies the same logic *before* first paint to
 * avoid a flash; {@link theme.init} re-applies it and wires the OS-change
 * listener once React is up.
 *
 * tldraw consumes `mode` directly: its user preference `colorScheme` accepts the
 * same `'light' | 'dark' | 'system'` values, so {@link CanvasIsland} mirrors this
 * store straight into `editor.user.updateUserPreferences`.
 */

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'ai-storm.theme'

function readStored(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system'
}

interface ThemeState {
  mode: ThemeMode
}

export const useThemeStore = create<ThemeState>(() => ({ mode: readStored() }))

const media = window.matchMedia('(prefers-color-scheme: dark)')

/** The concrete palette a given choice resolves to right now. */
function resolve(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? (media.matches ? 'dark' : 'light') : mode
}

function apply(mode: ThemeMode): void {
  const r = resolve(mode)
  const root = document.documentElement
  root.classList.toggle('dark', r === 'dark')
  root.style.colorScheme = r
}

export const theme = {
  /** Re-apply the stored choice and follow the OS when in 'system' mode. */
  init(): void {
    apply(useThemeStore.getState().mode)
    media.addEventListener('change', () => {
      if (useThemeStore.getState().mode === 'system') apply('system')
    })
  },

  /** Persist + apply a new choice (also re-mirrored into tldraw by the island). */
  set(mode: ThemeMode): void {
    localStorage.setItem(STORAGE_KEY, mode)
    useThemeStore.setState({ mode })
    apply(mode)
  },
}
