/**
 * Turn a flattened terminal capture back into a stream xterm.js can render.
 *
 * Reattachment starts with a fresh browser-side terminal, while the PTY/tmux
 * pane has retained its screen and scrollback. Clear any stale client content,
 * home the cursor, then replay the capture with CRLF line endings (a bare LF
 * does not return an xterm cursor to column zero).
 */
export function replayCapture(capture: string): string {
  const clearAndHome = "\x1b[2J\x1b[3J\x1b[H";
  return clearAndHome + capture.replace(/\r?\n/g, "\r\n");
}
