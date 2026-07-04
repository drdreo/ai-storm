import { readFileSync } from "node:fs";

/**
 * In-memory tmux fake shared by the tmux-backend test suites
 * (`extraction.test.ts`, `mcp/endpoint.test.ts`): tracks session existence,
 * launch command, per-session user options (`set-option`/`show-options`),
 * `list-sessions`, a settable `capture-pane` buffer, and every call made
 * (for assertions like "reused, not recreated").
 */
export function fakeTmux() {
  const calls: string[][] = [];
  const sessions = new Map<string, { launch: string; options: Record<string, string> }>();
  let pane = "";
  const argAfter = (args: string[], flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const tmux = async (...args: string[]): Promise<string> => {
    calls.push(args);
    const cmd = args[0];
    const name = argAfter(args, "-t");
    switch (cmd) {
      case "has-session":
        if (!sessions.has(name!)) throw new Error("no such session");
        return "";
      case "new-session": {
        // The launch command is the trailing positional arg. Long launches are
        // written to a temp script, so store the script body for assertions.
        const launch = args[args.length - 1];
        const script = launch.match(/^bash '(.+)'$/)?.[1];
        sessions.set(argAfter(args, "-s")!, {
          launch: script ? readFileSync(script, "utf8") : launch,
          options: {}
        });
        return "";
      }
      case "set-option": {
        const session = sessions.get(name!);
        if (!session) throw new Error("no such session");
        // trailing pair: <option> <value>
        session.options[args[args.length - 2]] = args[args.length - 1];
        return "";
      }
      case "show-options": {
        const session = sessions.get(name!);
        if (!session) throw new Error("no such session");
        return session.options[args[args.length - 1]] ?? "";
      }
      case "list-sessions":
        return [...sessions.keys()].join("\n");
      case "capture-pane":
        if (!sessions.has(name!)) throw new Error("no such session");
        return pane;
      case "kill-session":
        sessions.delete(name!);
        return "";
      default:
        return "";
    }
  };
  const count = (cmd: string): number => calls.filter((a) => a[0] === cmd).length;
  return { tmux, sessions, calls, count, setPane: (text: string) => (pane = text) };
}
