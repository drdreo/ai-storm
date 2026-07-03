import { create } from "zustand";

/**
 * App theme preferences (#77 + follow-up) — five INDEPENDENT knobs the user can
 * mix freely. Each maps to one channel on `<html>`, and the CSS in `index.css`
 * keys off them:
 *
 *   • mode     — light / dark / system   → toggles the `.dark` class
 *   • palette  — slate / ember           → `data-theme`  (omitted for slate)
 *   • font     — grotesque / humanist / mono → `data-font`  (drives --app-font-sans)
 *   • radius   — sharp / default / round  → `data-radius` (drives --radius)
 *   • density  — compact / comfortable    → `data-density` (drives Tailwind's --spacing)
 *   • contrast — normal / high            → `data-contrast` (overrides fg/border tokens)
 *
 * All persist to localStorage and are re-applied before first paint by the inline
 * boot script in `index.html` (kept in sync with `applyAll` below) to avoid a
 * flash. {@link theme.init} re-applies them and wires the OS-change listener once
 * React is up.
 *
 * tldraw consumes only `mode` (its `colorScheme` preference), mirrored by
 * {@link CanvasIsland}; the other four knobs are app-chrome only.
 */

export type ThemeMode = "light" | "dark" | "system";
export type ThemePalette = "slate" | "ember";
export type ThemeFont = "grotesque" | "humanist" | "mono";
export type ThemeRadius = "sharp" | "default" | "round";
export type ThemeDensity = "compact" | "comfortable";
export type ThemeContrast = "normal" | "high";

interface ThemeState {
  mode: ThemeMode;
  palette: ThemePalette;
  font: ThemeFont;
  radius: ThemeRadius;
  density: ThemeDensity;
  contrast: ThemeContrast;
}

const KEY: Record<keyof ThemeState, string> = {
  mode: "ai-storm.theme",
  palette: "ai-storm.palette",
  font: "ai-storm.font",
  radius: "ai-storm.radius",
  density: "ai-storm.density",
  contrast: "ai-storm.contrast"
};

/** Read a persisted enum value, falling back to `fallback` if absent/invalid. */
function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const v = localStorage.getItem(key);
  return (allowed as readonly string[]).includes(v ?? "") ? (v as T) : fallback;
}

function readState(): ThemeState {
  return {
    mode: read(KEY.mode, ["light", "dark", "system"], "system"),
    palette: read(KEY.palette, ["slate", "ember"], "slate"),
    font: read(KEY.font, ["grotesque", "humanist", "mono"], "grotesque"),
    radius: read(KEY.radius, ["sharp", "default", "round"], "default"),
    density: read(KEY.density, ["compact", "comfortable"], "comfortable"),
    contrast: read(KEY.contrast, ["normal", "high"], "normal")
  };
}

export const useThemeStore = create<ThemeState>(() => readState());

const media = window.matchMedia("(prefers-color-scheme: dark)");

/** The concrete brightness a given choice resolves to right now. */
function resolve(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? (media.matches ? "dark" : "light") : mode;
}

/** Reflect the whole preference set onto `<html>` (mirrors index.html's boot script). */
function applyAll(s: ThemeState): void {
  const root = document.documentElement;
  const r = resolve(s.mode);
  root.classList.toggle("dark", r === "dark");
  root.style.colorScheme = r;
  // Default palette = bare :root tokens, so leave the attribute off for slate.
  if (s.palette === "slate") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", s.palette);
  root.setAttribute("data-font", s.font);
  root.setAttribute("data-radius", s.radius);
  root.setAttribute("data-density", s.density);
  root.setAttribute("data-contrast", s.contrast);
}

/** Persist a single knob, update the store, and re-apply to `<html>`. */
function update<K extends keyof ThemeState>(key: K, value: ThemeState[K]): void {
  localStorage.setItem(KEY[key], value);
  useThemeStore.setState({ [key]: value } as Pick<ThemeState, K>);
  applyAll(useThemeStore.getState());
}

export const theme = {
  /** Re-apply the stored choices and follow the OS when in 'system' mode. */
  init(): void {
    applyAll(useThemeStore.getState());
    media.addEventListener("change", () => {
      if (useThemeStore.getState().mode === "system") applyAll(useThemeStore.getState());
    });
  },

  /** Brightness (also re-mirrored into tldraw by the canvas island). */
  set: (mode: ThemeMode) => update("mode", mode),
  setPalette: (palette: ThemePalette) => update("palette", palette),
  setFont: (font: ThemeFont) => update("font", font),
  setRadius: (radius: ThemeRadius) => update("radius", radius),
  setDensity: (density: ThemeDensity) => update("density", density),
  setContrast: (contrast: ThemeContrast) => update("contrast", contrast)
};
