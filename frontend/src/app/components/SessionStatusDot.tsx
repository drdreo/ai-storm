import { cn } from "@/lib/utils";
import { useProjectStore, selectActive } from "../stores/project.store";
import { useIngestionStore } from "../stores/ingestion.store";
import { useBackendStore } from "../stores/backend.store";
import { sessionIndicator, type SessionTone } from "../core/session-status";

export const TONE_DOT: Record<SessionTone, string> = {
  ok: "bg-emerald-500",
  pending: "bg-amber-500 animate-pulse",
  error: "bg-destructive"
};

/**
 * The session indicator, dot-only — shown on the collapsed Control Hub rail
 * (#109) so a lost backend or session error stays visible while the hub (and
 * its dot+label header) is out of sight. Same derivation as the hub header:
 * one indication, two densities.
 */
export function SessionStatusDot() {
  const ws = useProjectStore(selectActive);
  const connState = useBackendStore((s) => s.state);
  const attached = useIngestionStore((s) => (ws ? !!s.attached[ws.id] : false));

  if (!ws) return null;
  const indicator = sessionIndicator(connState, attached, ws.status);

  return (
    <span
      role="status"
      aria-label={`Session: ${indicator.label}`}
      title={`${indicator.label} — ${indicator.detail}`}
      className={cn("size-2 rounded-full", TONE_DOT[indicator.tone])}
    />
  );
}
