/**
 * Tiny terminal-output helpers for the launcher. No dependencies; ANSI colors
 * are used only when stdout is a TTY (so piping `ai-storm status` stays clean).
 */

const tty = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

function paint(code: string, text: string): string {
  return tty ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export const color = {
  green: (t: string) => paint("32", t),
  red: (t: string) => paint("31", t),
  yellow: (t: string) => paint("33", t),
  cyan: (t: string) => paint("36", t),
  dim: (t: string) => paint("2", t),
  bold: (t: string) => paint("1", t)
};

export const mark = {
  ok: color.green("✓"),
  fail: color.red("✗"),
  warn: color.yellow("!")
};

export function info(msg: string): void {
  console.log(msg);
}

export function fail(msg: string): never {
  console.error(`${mark.fail} ${msg}`);
  process.exit(1);
}
