import { create } from "zustand";
import type { Idea, TerminalConfig } from "@ai-storm/shared";
import { backend } from "./backend.store";
import { canvas } from "./canvas.store";
import { project } from "./project.store";
import { RenderScheduler } from "../core/render-scheduler";

/** Cap on raw bytes buffered before a terminal mounts, so an attached-but-never-
 *  viewed project cannot grow without bound (oldest chunks are dropped). */
const MAX_BUFFERED_DATA = 256 * 1024;

/** A mounted xterm.js terminal's sink — the component registers these. */
export interface TerminalSink {
  /** Write base64-encoded raw PTY bytes to the terminal. */
  write(dataB64: string): void;
  /** Clear the terminal's scrollback + viewport. */
  clear(): void;
  /** Move keyboard focus into the terminal (bidirectional canvas, #13). */
  focus?(): void;
}

/** Live streaming machinery (exists only while a session is attached). */
interface Pipeline {
  scheduler: RenderScheduler<Idea>;
  unsubscribe: () => void;
  /** The attach message, re-sent on socket reopen to resume the session (§3.5). */
  reattach: () => void;
  unsubscribeOpen: () => void;
}

/** Per-project terminal binding (survives attach/detach cycles). */
interface TerminalState {
  /** The mounted terminal's sink, or null until the component registers it. */
  sink: TerminalSink | null;
  /** Raw `data` chunks (base64) received before the terminal mounted. */
  buffer: string[];
  bufferedBytes: number;
}

/**
 * Stateful ingestion pipeline (PRD §3.3 + §5.1).
 *
 * The backend streams two surfaces per project
 * (docs/design/ai-response-extraction-contract.md):
 *
 *   `data` → raw PTY bytes → the project's xterm.js terminal.
 *   `idea` → RenderScheduler<Idea> → canvas.applyIdeas — one discrete card per
 *            idea, with ideas arriving in the same paint frame collapsed into a
 *            single batched mutation.
 *
 * Pipelines are independent per project (PRD §3.4) and torn down on detach
 * (PRD §5.2); the lightweight terminal binding persists so a project keeps its
 * terminal across attach/detach cycles.
 *
 * Port note: the only reactive surface is which projects are attached
 * (`attached`), which the control hub reads to flip Start/Stop and the empty
 * state. Everything else is imperative module state, as in the Angular service.
 */

interface IngestionState {
  attached: Record<string, true>;
  /**
   * Last backend error per project (e.g. a harness that couldn't be launched).
   * Transient — not persisted with the project registry, since it describes a
   * momentary launch/runtime condition the user should be able to read and act
   * on, then dismiss. Cleared when the project next attaches or is stopped.
   */
  errors: Record<string, string>;
}

export const useIngestionStore = create<IngestionState>(() => ({ attached: {}, errors: {} }));

function setError(projectId: string, message: string | null): void {
  useIngestionStore.setState((s) => {
    if (message === (s.errors[projectId] ?? null)) return s;
    const next = { ...s.errors };
    if (message) next[projectId] = message;
    else delete next[projectId];
    return { errors: next };
  });
}

// ---- Imperative module state -----------------------------------------------

const terminals = new Map<string, TerminalState>();
const active = new Map<string, Pipeline>();

function terminal(projectId: string): TerminalState {
  let t = terminals.get(projectId);
  if (!t) {
    t = { sink: null, buffer: [], bufferedBytes: 0 };
    terminals.set(projectId, t);
  }
  return t;
}

function markAttached(projectId: string, on: boolean): void {
  useIngestionStore.setState((s) => {
    if (on === !!s.attached[projectId]) return s;
    const next = { ...s.attached };
    if (on) next[projectId] = true;
    else delete next[projectId];
    return { attached: next };
  });
}

/** Forward raw PTY bytes to the terminal (or buffer until it mounts). */
function ingestData(projectId: string, dataB64: string): void {
  const t = terminal(projectId);
  if (t.sink) {
    t.sink.write(dataB64);
    return;
  }
  t.buffer.push(dataB64);
  t.bufferedBytes += dataB64.length;
  // Drop oldest chunks past the cap (a never-viewed session must stay bounded).
  while (t.bufferedBytes > MAX_BUFFERED_DATA && t.buffer.length > 1) {
    t.bufferedBytes -= t.buffer.shift()!.length;
  }
}

/** Route one extracted idea to the canvas via the render scheduler. */
function ingestIdea(projectId: string, idea: Idea): void {
  const p = active.get(projectId);
  if (!p) return;
  p.scheduler.enqueueAll([idea]);
}

function applyStatus(projectId: string, status: string): void {
  switch (status) {
    case "responding":
      project.setStatus(projectId, "streaming");
      break;
    case "created":
    case "attached":
    case "idle":
      project.setStatus(projectId, "active");
      break;
    case "killed":
      project.setStatus(projectId, "idle");
      break;
  }
}

function teardownPipeline(projectId: string): Pipeline | undefined {
  const p = active.get(projectId);
  if (!p) return undefined;
  p.unsubscribe();
  p.unsubscribeOpen();
  p.scheduler.dispose();
  active.delete(projectId);
  markAttached(projectId, false);
  return p;
}

export const ingestion = {
  /**
   * Ensure the durable session exists and start ingesting its streams.
   * Idempotent (PRD §3.5): a second call for an already-attached project is a
   * no-op, and the backend reuses a running session rather than respawning it.
   */
  attach(projectId: string, config: TerminalConfig, cols = 120, rows = 32): void {
    if (active.has(projectId)) return;
    // A fresh attempt clears any error from the previous launch.
    setError(projectId, null);
    // Pre-create the terminal binding so a sink can register immediately.
    terminal(projectId);

    const scheduler = new RenderScheduler<Idea>({
      sink: (batch) => canvas.applyIdeas(projectId, batch),
      // Ideas are low-frequency and deduped one-per-marker; a small cap still
      // collapses multiple ideas in one frame into a single applyIdeas call.
      maxPerFrame: 8
    });

    const unsubscribe = backend.subscribe(projectId, (msg) => {
      switch (msg.type) {
        case "data":
          ingestData(projectId, msg.data);
          break;
        case "idea":
          ingestIdea(projectId, msg.idea);
          break;
        case "score":
          // Triage score (#60) → update the target card's meta on the canvas.
          canvas.applyScore(projectId, msg.score);
          break;
        case "session-status":
          applyStatus(projectId, msg.status);
          break;
        case "exit":
          active.get(projectId)?.scheduler.flushNow();
          project.setStatus(projectId, "idle");
          break;
        case "error":
          project.setStatus(projectId, "error");
          // Surface *why* so the user can fix it (e.g. a bad harness command),
          // rather than seeing only an opaque "error" status.
          setError(projectId, msg.message);
          break;
      }
    });

    // The interactive session defaults to launching the configured AI harness
    // (e.g. `claude`), so prompts typed in the terminal go to the agent — not to
    // a raw shell. An explicit `shell` override takes precedence.
    const harness = config.shell?.trim() || config.agentCommand?.trim() || "claude";
    const harnessArgs = config.shell ? (config.args ?? []) : (config.agentArgs ?? []);
    const reattach = () => {
      backend.send({
        type: "attach",
        projectId,
        shell: harness,
        args: harnessArgs,
        cwd: config.cwd,
        cols,
        rows,
        mode: config.mode,
        background: config.background
      });
    };
    // Re-issue the attach whenever the socket (re)opens so a backend restart or
    // refresh resumes the durable session without losing the agent (§3.5).
    const unsubscribeOpen = backend.onOpen(reattach);

    active.set(projectId, { scheduler, unsubscribe, reattach, unsubscribeOpen });
    markAttached(projectId, true);

    backend.connect();
    reattach();
  },

  /**
   * Bind a mounted terminal for a project. Flushes any data buffered before
   * the terminal mounted, then forwards subsequent `data` live. Returns an
   * unbind fn the component calls on teardown.
   */
  registerTerminal(projectId: string, sink: TerminalSink): () => void {
    const t = terminal(projectId);
    t.sink = sink;
    if (t.buffer.length > 0) {
      for (const chunk of t.buffer) sink.write(chunk);
      t.buffer = [];
      t.bufferedBytes = 0;
    }
    return () => {
      if (t.sink === sink) t.sink = null;
    };
  },

  /** Forward raw keystrokes from the terminal to the session's PTY. */
  sendInput(projectId: string, data: string): void {
    backend.send({ type: "input", projectId, data });
  },

  resize(projectId: string, cols: number, rows: number): void {
    backend.send({ type: "resize", projectId, cols, rows });
  },

  /** Dismiss the last backend error shown for a project. */
  clearError(projectId: string): void {
    setError(projectId, null);
  },

  /** Clear the project's terminal display (does not touch the session). */
  clearTerminal(projectId: string): void {
    terminals.get(projectId)?.sink?.clear();
  },

  /**
   * Move keyboard focus into the project's terminal (bidirectional canvas,
   * #13). Used after typing a framed prompt so the user can edit/submit it
   * without first clicking the terminal. No-op if no terminal is mounted.
   */
  focusTerminal(projectId: string): void {
    terminals.get(projectId)?.sink?.focus?.();
  },

  isAttached(projectId: string): boolean {
    return active.has(projectId);
  },

  /**
   * Stop ingesting locally but LEAVE the durable session alive on the backend
   * (refresh / hot-switch — PRD §3.5). Use {@link kill} to tear it down.
   */
  detach(projectId: string): void {
    const p = teardownPipeline(projectId);
    if (!p) return;
    backend.send({ type: "detach", projectId });
    project.setStatus(projectId, "idle");
  },

  /** Terminate the session entirely (PRD §5.2 teardown). */
  kill(projectId: string): void {
    const p = teardownPipeline(projectId);
    backend.send({ type: "kill", projectId });
    if (p) project.setStatus(projectId, "idle");
  }
};
