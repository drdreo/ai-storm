/**
 * Terminal garbage elimination (PRD §3.3).
 *
 * Strips ANSI escape sequences, SGR color/style parameters, cursor controls,
 * OSC strings, and other terminal control bytes so the response extractor sees
 * clean, uncorrupted text. Pure & framework-agnostic so it is unit-testable
 * outside any runtime. No literal control bytes appear in this source — every
 * control character is expressed as a \u escape so the file stays ASCII-safe.
 *
 * This previously lived client-side (`frontend/src/app/core/ansi.ts`). The
 * response layer is now extracted backend-side, so the cleaning logic moved
 * here with it: `tmux capture-pane -p` already drops escapes, but it is applied
 * as defence-in-depth for residual control bytes (design §4.3 step 3), and the
 * Windows node-pty backend relies on it to clean the raw PTY byte stream.
 */

const ESC = String.fromCharCode(0x1b); // 7-bit escape introducer
const CSI8 = String.fromCharCode(0x9b); // 8-bit CSI introducer

const ANSI_PATTERN = new RegExp(
  [
    // OSC sequences (tested first so CSI can't eat the introducer):
    //   ESC ] ... (BEL | ESC \) — window titles, hyperlinks
    "\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)",
    // CSI sequences (ECMA-48): introducer, parameter bytes 0x30–0x3F,
    //   intermediate bytes 0x20–0x2F, final byte 0x40–0x7E.
    "(?:\\u001B\\[|\\u009B)[\\u0030-\\u003F]*[\\u0020-\\u002F]*[\\u0040-\\u007E]",
    // Charset selection: ESC ( X  /  ESC ) X
    "\\u001B[()][AB0-2]",
    // Single-character escapes: ESC + one byte in @..Z or \.._
    //   (excludes 0x5B '[' and 0x5D ']' which start CSI/OSC, handled above).
    "\\u001B[\\u0040-\\u005A\\u005E-\\u005F]"
  ].join("|"),
  "g"
);

// Stray C0 control bytes (0x00–0x08, 0x0B, 0x0C, 0x0E–0x1F) plus DEL (0x7F),
// excluding \t (0x09), \n (0x0A), \r (0x0D) which carry layout meaning.
const STRAY_CONTROL = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]", "g");

/** Remove all ANSI escape sequences from a string. */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, "");
}

/**
 * Full sanitisation pass: strip ANSI sequences and remaining stray control
 * bytes, while preserving newline/carriage-return/tab semantics.
 */
export function sanitize(input: string): string {
  return stripAnsi(input).replace(STRAY_CONTROL, "");
}

/**
 * Detect whether a chunk ends mid-escape-sequence (an ESC introducer with no
 * terminating final byte yet). The line buffer uses this to hold back a
 * fragment that would otherwise split an escape across chunk boundaries.
 */
export function endsWithPartialEscape(input: string): boolean {
  const lastEsc = Math.max(input.lastIndexOf(ESC), input.lastIndexOf(CSI8));
  if (lastEsc === -1) return false;
  // A complete sequence starting at lastEsc would be removed by stripAnsi; if
  // an ESC/CSI byte survives the strip, the terminating byte hasn't arrived.
  const tail = stripAnsi(input.slice(lastEsc));
  return tail.includes(ESC) || tail.includes(CSI8);
}
