/**
 * Single session indicator for the Control Hub header — the consolidation of
 * the retired readiness checklist (#97). Connection state and workspace status
 * used to be shown side by side (plus a per-check list below), but the only
 * check that could ever change was the backend connection; everything else was
 * green by construction or duplicated the setup inputs themselves. One derived
 * dot + label answers the real question: "can I start / what's running?"
 */

import type { ConnectionState } from "../stores/backend.store";
import type { WorkspaceStatus } from "./models";

export type SessionTone = "error" | "pending" | "ok";

export interface SessionIndicator {
  tone: SessionTone;
  label: string;
  /** Hover detail — the *why*, e.g. what an offline backend means for Start. */
  detail: string;
}

export function sessionIndicator(conn: ConnectionState, attached: boolean, status: WorkspaceStatus): SessionIndicator {
  if (conn === "closed") {
    return {
      tone: "error",
      label: "backend offline",
      detail: "The backend is not reachable — a session cannot be launched."
    };
  }
  if (conn === "connecting") {
    return {
      tone: "pending",
      label: "connecting",
      detail: "Connecting to the backend…"
    };
  }
  if (!attached) {
    return {
      tone: "ok",
      label: "ready",
      detail: "Backend connected — configure the session setup below and press Start."
    };
  }
  if (status === "error") {
    return {
      tone: "error",
      label: "session error",
      detail: "The session hit an error — see the message above."
    };
  }
  return {
    tone: "ok",
    label: status === "streaming" ? "streaming" : "session live",
    detail: "Session is running — talk to the agent in the terminal."
  };
}
