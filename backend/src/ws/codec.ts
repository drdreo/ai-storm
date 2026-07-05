/**
 * Serializes a {@link ServerMessage} into the wire string sent to the client
 * (#137). Client messages already have a canonical parser/validator in
 * `@ai-storm/shared`'s `parseClientMessage`; this is its outgoing
 * counterpart, so `server.ts` never calls `JSON.stringify` on a socket
 * message directly.
 */

import type { ServerMessage } from "@ai-storm/shared";

export function encodeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
