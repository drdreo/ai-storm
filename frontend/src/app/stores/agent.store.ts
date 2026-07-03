import { create } from "zustand";
import { backend } from "./backend.store";
import { canvas } from "./canvas.store";
import { ingestion } from "./ingestion.store";
import {
  framePrompt,
  frameTriage,
  frameSpec,
  type PromptIntent,
  type SpecFormat,
  type SpecOptions
} from "../core/prompt-framing";
import type { TerminalConfig } from "../core/models";
import type { AgentArtifact } from "@ai-storm/shared";
import { log } from "../../lib/log";

export interface AgentRun {
  status: "spawned" | "running" | "exit" | "error";
  pid?: number;
  output: string;
  code?: number;
  /**
   * What kicked the run off (#89). Currently only the spec/PRD hand-off spawns a
   * run, shown in its own SpecPanel; the field stays so any future run type can be
   * routed to a different surface without conflating it with the spec artifact.
   */
  kind?: "spec";
  /**
   * Which output format the spec run was framed as (#110), stamped at dispatch —
   * so the SpecPanel can label the status badge and name the download even after
   * the panel reopens with a different picker selection.
   */
  format?: SpecFormat;
  /**
   * Structured artifacts the backend parsed out of the finished run (#120) —
   * created GitHub issues as `{ title, url }`, rendered as link chips in the
   * SpecPanel. Present only after an `agent-artifacts` message arrived.
   */
  artifacts?: AgentArtifact[];
}

/**
 * The canvas → agent seams.
 *
 * - `discussText` is the bidirectional-canvas seam (#13): it types a framed,
 *   EDITABLE prompt into the live interactive session for the user to submit.
 * - `triage` (#60) submits a complete ref-annotated scoring request into the
 *   live session.
 * - `generateSpec` (#89) is the downstream agent hand-off (PRD §3.6): it spawns
 *   the local orchestrator subprocess with a spec/PRD-shaped payload and streams
 *   the generated artifact back into the store for the SpecPanel.
 *
 * Per-workspace run lifecycle is held in the `runs` record of this Zustand store.
 */

interface AgentState {
  runs: Record<string, AgentRun | null>;
}

export const useAgentStore = create<AgentState>(() => ({ runs: {} }));

const subscribed = new Set<string>();

function setRun(workspaceId: string, run: AgentRun | null): void {
  useAgentStore.setState((s) => ({ runs: { ...s.runs, [workspaceId]: run } }));
}

function getRun(workspaceId: string): AgentRun | null {
  return useAgentStore.getState().runs[workspaceId] ?? null;
}

function ensureSubscription(workspaceId: string): void {
  if (subscribed.has(workspaceId)) return;
  subscribed.add(workspaceId);
  backend.subscribe(workspaceId, (msg) => {
    if (msg.type === "agent-artifacts") {
      const run = getRun(workspaceId);
      if (run) setRun(workspaceId, { ...run, artifacts: msg.artifacts });
      return;
    }
    if (msg.type !== "agent-status") return;
    const cur = getRun(workspaceId) ?? { status: "spawned", output: "" };
    switch (msg.status) {
      case "spawned":
        setRun(workspaceId, {
          status: "running",
          pid: msg.pid,
          output: "",
          kind: cur.kind,
          // Prefer the backend-echoed format (#120): it survives where the
          // dispatch-time stamp doesn't (refresh, second tab).
          format: msg.format ?? cur.format
        });
        break;
      case "stdout":
      case "stderr":
        setRun(workspaceId, { ...cur, status: "running", output: cur.output + (msg.data ?? "") });
        break;
      case "exit":
        setRun(workspaceId, { ...cur, status: "exit", code: msg.code });
        break;
      case "error":
        log.error("agent.run_error", { workspace: workspaceId, data: msg.data });
        setRun(workspaceId, { ...cur, status: "error", output: cur.output + (msg.data ?? "") });
        break;
    }
  });
}

export const agent = {
  /**
   * Spec/PRD hand-off (#89, PD-015) — close the brainstorm → structure → hand-off
   * loop (PRD §2). Serializes the selection (or the whole board) lifecycle-aware
   * (superseded ghosts dropped, keep-marks flagged), frames it into a spec/PRD
   * request, and dispatches it through the local-orchestrator subprocess seam
   * (PD-007 / PRD §3.6). Unlike {@link dispatch}, the payload is the framed spec
   * prompt itself — not the selection wrapped in board context — since the agent's
   * whole job here is to converge the board into a generated spec artifact. The
   * run streams back into the store and surfaces in the control hub (with markdown
   * export) exactly like a `dispatch` run.
   *
   * `format` (#110) picks how the request is framed — PRD, implementation plan,
   * GitHub issues, or agent task prompts — and is stamped on the run so the panel
   * can label and name the artifact; `opts` carries the issues create-toggle.
   *
   * @returns `true` if a run was dispatched; `false` if the board is empty.
   */
  generateSpec(
    workspaceId: string,
    config: TerminalConfig,
    format: SpecFormat = "prd",
    opts: SpecOptions = {}
  ): boolean {
    const payload = frameSpec(canvas.serializeForHandoff(workspaceId), format, opts);
    if (!payload) return false;
    const command = config.agentCommand?.trim() || "claude";

    ensureSubscription(workspaceId);
    setRun(workspaceId, { status: "spawned", output: "", kind: "spec", format });

    backend.connect();
    backend.send({
      type: "agent",
      workspaceId,
      command,
      args: config.agentArgs ?? [],
      payload,
      cwd: config.cwd,
      format,
      // The side-effecting issues create-mode asks for a NAMED capability
      // (#120); the backend maps it to a vetted, run-scoped permission flag —
      // no more baking `gh` permission into the global agent args.
      capabilities: opts.createIssues ? ["create-issues"] : []
    });
    return true;
  },

  /**
   * Bidirectional canvas (#13) — feed the given canvas text into the LIVE
   * interactive terminal session as an EDITABLE prompt (no trailing newline, so
   * the cursor lands ready for the user to edit and submit it themselves).
   *
   * @returns `true` if a prompt was typed; `false` if no session is attached or
   *   the text is empty.
   */
  discussText(
    workspaceId: string,
    text: string,
    intent: PromptIntent = "discuss",
    sourceRefs: readonly string[] = []
  ): boolean {
    if (!ingestion.isAttached(workspaceId)) return false;
    const prompt = framePrompt(text.trim() ? text : "", intent, sourceRefs);
    if (!prompt) return false;
    // No '\r': the prompt stays editable in the terminal until the user submits.
    ingestion.sendInput(workspaceId, prompt);
    ingestion.focusTerminal(workspaceId);
    return true;
  },

  /**
   * AI triage (#60) — serialize the whole board (ref-annotated) and ask the live
   * agent to rate every card for impact/effort/confidence. Unlike {@link discussText},
   * this is SUBMITTED (trailing '\r') because it's a complete request: the agent's
   * `«SCORE@ref»` reply is extracted and flows back to the canvas via
   * `canvas.applyScore`, then "▦ Grid" lays the scored board out.
   *
   * @returns `true` if a triage prompt was submitted; `false` if no session is
   *   attached or the board is empty.
   */
  triage(workspaceId: string): boolean {
    if (!ingestion.isAttached(workspaceId)) return false;
    const prompt = frameTriage(canvas.serializeForTriage(workspaceId));
    if (!prompt) return false;
    // Trailing '\r' submits it — a triage pass is a complete request, not an
    // editable seam like the card verbs.
    ingestion.sendInput(workspaceId, prompt + "\r");
    ingestion.focusTerminal(workspaceId);
    return true;
  }
};
