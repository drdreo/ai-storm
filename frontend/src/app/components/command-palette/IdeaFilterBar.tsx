/**
 * The idea-search facet bar (#124) shown under the palette's input: provenance /
 * mark / triage / kind / date chips that narrow which ideas the full-text search
 * considers. Owns the date-preset config; the palette owns the filter state.
 */
import { cn } from "@/lib/utils";
import { Bot, CalendarClock, Sparkles, Star, User } from "lucide-react";
import type { IdeaSearchFilter } from "../../core/canvas/search";
import { kindLabel } from "../../core/idea-descriptors";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Date facet presets (#124) — cycled by the "Any time" chip. */
export const DATE_PRESETS = [
  { id: "any", label: "Any time", ms: undefined },
  { id: "1d", label: "Past 24h", ms: DAY_MS },
  { id: "7d", label: "Past 7 days", ms: 7 * DAY_MS },
  { id: "30d", label: "Past 30 days", ms: 30 * DAY_MS }
] as const;

export type DatePreset = (typeof DATE_PRESETS)[number];

/** A small pressable filter chip — pressed state mirrors an active facet. */
function FilterChip({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input bg-transparent text-muted-foreground hover:bg-muted"
      )}
    >
      {children}
    </button>
  );
}

export function IdeaFilterBar({
  filter,
  onChange,
  availableKinds,
  datePreset,
  onCycleDate
}: {
  filter: IdeaSearchFilter;
  onChange(next: IdeaSearchFilter): void;
  availableKinds: readonly string[];
  datePreset: DatePreset;
  onCycleDate(): void;
}) {
  const toggleKind = (kind: string) => {
    const kinds = new Set(filter.kinds);
    if (kinds.has(kind)) kinds.delete(kind);
    else kinds.add(kind);
    onChange({ ...filter, kinds });
  };
  const setOrigin = (origin: IdeaSearchFilter["origin"]) =>
    onChange({ ...filter, origin: filter.origin === origin ? "all" : origin });

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-2 py-2">
      <FilterChip active={filter.origin === "ai"} onClick={() => setOrigin("ai")}>
        <Bot className="size-3" /> AI
      </FilterChip>
      <FilterChip active={filter.origin === "user"} onClick={() => setOrigin("user")}>
        <User className="size-3" /> User
      </FilterChip>
      <FilterChip active={filter.markedOnly} onClick={() => onChange({ ...filter, markedOnly: !filter.markedOnly })}>
        <Star className="size-3" /> Marked
      </FilterChip>
      <FilterChip active={filter.triagedOnly} onClick={() => onChange({ ...filter, triagedOnly: !filter.triagedOnly })}>
        <Sparkles className="size-3" /> Triaged
      </FilterChip>
      <FilterChip active={datePreset.id !== "any"} onClick={onCycleDate}>
        <CalendarClock className="size-3" /> {datePreset.label}
      </FilterChip>
      {availableKinds.map((kind) => (
        <FilterChip key={kind} active={filter.kinds.has(kind)} onClick={() => toggleKind(kind)}>
          {kindLabel(kind)}
        </FilterChip>
      ))}
    </div>
  );
}
