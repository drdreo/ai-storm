import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useWorkspaceStore, selectActive } from "../stores/workspace.store";
import { ingestion } from "../stores/ingestion.store";
import { useThemeStore } from "../stores/theme.store";

/** One live xterm.js terminal bound to a workspace's session. */
interface Entry {
  term: Xterm;
  fit: FitAddon;
  /** The DOM node xterm renders into; appended to the host when active. */
  container: HTMLDivElement;
  /** False until xterm has been opened + wired (done once it is in the DOM). */
  wired: boolean;
  /** Disposes the onData keystroke forwarder. */
  dataDisp: { dispose(): void } | null;
  /** Unregisters the ingestion data sink. */
  unregister: (() => void) | null;
}

/** Decode base64 PTY bytes into a Uint8Array xterm can write as UTF-8. */
function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Get the current terminal background color from CSS. */
function getTerminalBackgroundColor(): string {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  return styles.getPropertyValue("--background").trim() || "#0a0a0a";
}

/**
 * The conversation surface (PRD §3.1) as a REAL terminal. The backend streams
 * raw PTY bytes (`data`); xterm.js renders them, so tool calls, todos,
 * clarifying questions and diffs all show exactly as the harness draws them —
 * no server-side chat extraction. Keystrokes flow back out via `onData` →
 * `input`. Ideas are handled separately by the canvas.
 *
 * One {@link Xterm} per workspace is kept so each isolated workspace (PRD §3.4)
 * retains its own scrollback; only the active workspace's terminal is attached
 * to the host element, swapped on hot-switch.
 */
export function Terminal() {
  const activeId = useWorkspaceStore((s) => selectActive(s)?.id ?? null);
  const hostRef = useRef<HTMLDivElement>(null);
  const entries = useRef(new Map<string, Entry>());
  const resizeObserver = useRef<ResizeObserver | null>(null);
  const shownId = useRef<string | null>(null);

  // Follow the active workspace: show its terminal, creating it on first view.
  useEffect(() => {
    const hostEl = hostRef.current;
    if (!activeId || !hostEl) return;
    show(activeId, hostEl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Update terminal themes when app theme changes.
  useEffect(() => {
    const unsubscribe = useThemeStore.subscribe(() => {
      const bgColor = getTerminalBackgroundColor();
      for (const entry of entries.current.values()) {
        entry.term.options.theme = { background: bgColor };
      }
    });
    return unsubscribe;
  }, []);

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      resizeObserver.current?.disconnect();
      for (const entry of entries.current.values()) {
        entry.dataDisp?.dispose();
        entry.unregister?.();
        entry.term.dispose();
      }
      entries.current.clear();
    };
  }, []);

  function show(workspaceId: string, hostEl: HTMLElement): void {
    if (shownId.current === workspaceId && entries.current.get(workspaceId)?.container.parentElement === hostEl) {
      return;
    }
    shownId.current = workspaceId;
    const entry = ensure(workspaceId);
    // Only the active workspace's terminal is in the DOM.
    hostEl.replaceChildren(entry.container);
    // Open + wire xterm now that its container is attached, so the renderer
    // measures real dimensions (opening on a detached node mis-measures).
    if (!entry.wired) wire(workspaceId, entry);
    observe(hostEl);
    // Fit after the swap lands so the container has real dimensions.
    queueMicrotask(() => fit(workspaceId));
  }

  function ensure(workspaceId: string): Entry {
    const existing = entries.current.get(workspaceId);
    if (existing) return existing;

    const container = document.createElement("div");
    container.className = "as-term";

    const term = new Xterm({
      cursorBlink: true,
      scrollback: 5000,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      // Match the current theme's background color from CSS.
      theme: { background: getTerminalBackgroundColor() }
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const entry: Entry = {
      term,
      fit: fitAddon,
      container,
      wired: false,
      dataDisp: null,
      unregister: null
    };
    entries.current.set(workspaceId, entry);
    return entry;
  }

  /** Open the terminal in its (now-attached) container and connect the streams. */
  function wire(workspaceId: string, entry: Entry): void {
    entry.term.open(entry.container);
    // Keystrokes → the session's PTY, verbatim.
    entry.dataDisp = entry.term.onData((d) => ingestion.sendInput(workspaceId, d));
    // Raw bytes from the session → the terminal.
    entry.unregister = ingestion.registerTerminal(workspaceId, {
      write: (b64) => entry.term.write(decodeBase64(b64)),
      clear: () => entry.term.clear(),
      // Bidirectional canvas (#13): focus the terminal after a framed prompt is
      // typed in, so the user can edit/submit it without clicking first.
      focus: () => entry.term.focus()
    });
    entry.wired = true;
  }

  function observe(hostEl: HTMLElement): void {
    if (resizeObserver.current) return;
    resizeObserver.current = new ResizeObserver(() => {
      if (shownId.current) fit(shownId.current);
    });
    resizeObserver.current.observe(hostEl);
  }

  /** Fit the active terminal to its container and inform the backend (cols/rows). */
  function fit(workspaceId: string): void {
    const entry = entries.current.get(workspaceId);
    if (!entry || entry.container.parentElement === null || entry.container.clientWidth === 0) {
      return;
    }
    try {
      entry.fit.fit();
      ingestion.resize(workspaceId, entry.term.cols, entry.term.rows);
    } catch {
      // Container not measurable yet; the next ResizeObserver tick retries.
    }
  }

  return <div ref={hostRef} className="box-border h-full w-full bg-background p-2" />;
}
