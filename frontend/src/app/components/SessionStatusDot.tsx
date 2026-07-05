import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useProjectStore, selectActive } from "../stores/project.store";
import { useIngestionStore } from "../stores/ingestion.store";
import { useBackendStore } from "../stores/backend.store";
import { sessionIndicator, type SessionTone } from "../core/session-status";

export const TONE_DOT: Record<SessionTone, string> = {
  ok: "bg-emerald-500",
  pending: "bg-amber-500",
  error: "bg-destructive"
};

/**
 * The dot itself, shared by the collapsed rail and the Control Hub header.
 * Breathes gently while `pending`, and settles with one quiet expanding ring
 * the instant the session lands on `ok` — an arrival cue for the moment the
 * terminal actually connects, in place of a mechanical pulse.
 */
export function StatusDot({ tone }: { tone: SessionTone }) {
  const prevTone = useRef(tone);
  const [justSettled, setJustSettled] = useState(false);

  useEffect(() => {
    if (prevTone.current === "pending" && tone === "ok") {
      setJustSettled(true);
      const timer = setTimeout(() => setJustSettled(false), 600);
      prevTone.current = tone;
      return () => clearTimeout(timer);
    }
    prevTone.current = tone;
  }, [tone]);

  return (
    <span className="relative inline-flex size-2 shrink-0">
      {justSettled && (
        <span
          aria-hidden="true"
          className={cn("status-dot-settle absolute inset-0 rounded-full", TONE_DOT.ok)}
        />
      )}
      <span className={cn("relative size-2 rounded-full", TONE_DOT[tone], tone === "pending" && "status-dot-breathe")} />
    </span>
  );
}

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
    <span role="status" aria-label={`Session: ${indicator.label}`} title={`${indicator.label} — ${indicator.detail}`}>
      <StatusDot tone={indicator.tone} />
    </span>
  );
}
