/**
 * WebSocket message codec (#137) — the single choke point that turns wire
 * bytes into a typed {@link ClientMessage} and a typed {@link ServerMessage}
 * back into wire bytes. `server.ts` calls only `decode`/`encode`; it never
 * touches `JSON.parse`/`JSON.stringify` itself, so the wire format (framing,
 * encoding) can change here without touching the Hono route or its dispatch
 * logic.
 */

import { parseClientMessage, type ClientMessage, type ServerMessage } from "@ai-storm/shared";

/** Decode a raw WebSocket text frame into a typed client message, or throw. */
export function decodeClientMessage(raw: string): ClientMessage {
  return parseClientMessage(raw);
}

/** Encode a typed server message into the wire string sent to the client. */
export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
