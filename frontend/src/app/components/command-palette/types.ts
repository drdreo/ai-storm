/**
 * Shared types for the board command palette (#96) — kept out of the view layer
 * so the action catalog ({@link buildCommandActions}) and the dialog component
 * agree on one contract without importing each other.
 */
import type { LucideIcon } from "lucide-react";
import type { BoardFilter } from "../../core/canvas/filter";

/** One runnable palette entry: what it says, where it groups, and when it's off. */
export interface CommandAction {
  id: string;
  group: string;
  label: string;
  hint: string;
  keywords?: readonly string[];
  icon: LucideIcon;
  shortcut?: string;
  disabledReason?: string;

  run(): void;
}

/** Live board facts used to explain disabled palette actions (#96). */
export interface BoardCommandState {
  mounted: boolean;
  cardCount: number;
  facets: {
    hasAi: boolean;
    hasUser: boolean;
    hasMarked: boolean;
    hasSuperseded: boolean;
    hasTriaged: boolean;
  };
  filter: BoardFilter;
}
