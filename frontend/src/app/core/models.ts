/** Frontend-local presentation helpers for the shared project domain model (PRD §3.4). */

import { DEFAULT_MODE_ID, type TerminalConfig } from "@ai-storm/shared";

/** Fixed accent palette (Tailwind 500s) — kept small so swatches stay distinguishable. */
export const PROJECT_COLORS = [
  "#f43f5e", // rose
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#0ea5e9", // sky
  "#6366f1", // indigo
  "#a855f7", // purple
  "#ec4899" // pink
] as const;

/** Deterministic default accent color, stable for a given project id. */
export function defaultProjectColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % PROJECT_COLORS.length;
  return PROJECT_COLORS[index];
}

export function defaultTerminalConfig(): TerminalConfig {
  return {
    agentCommand: "claude",
    agentArgs: [],
    mode: DEFAULT_MODE_ID
  };
}
