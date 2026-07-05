import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn/ui class-merge helper: conditional classes + Tailwind conflict resolution. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}



/** Humanize a millisecond span (seconds → hours). */
export function formatSpan(ms: number): string {
  const min = Math.round(ms / 60000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const hours = Math.round(min / 6) / 10;
  return `${hours} h`;
}
