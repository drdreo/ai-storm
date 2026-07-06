import { create } from "zustand";
import { backend } from "./backend.store";
import { canvas } from "./canvas.store";
import { history } from "./history.store";
import { ingestion } from "./ingestion.store";
import {
  framePrompt,
  frameReference,
  frameTriage,
  frameSpec,
  type PromptIntent,
  type ReferencedIdea,
  type SpecOptions
} from "../core/prompt-framing";
import type { AgentArtifact, SpecFormat, TerminalConfig } from "@ai-storm/shared";
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
 * Per-project run lifecycle is held in the `runs` record of this Zustand store.
 */

interface AgentState {
  runs: Record<string, AgentRun | null>;
}

export const useAgentStore = create<AgentState>(() => ({ runs: {} }));

const subscribed = new Set<string>();

/**
 * The run-history entry (#104) tracking each project's latest spec run. Kept
 * after the run finishes (late `agent-artifacts` messages still attach to it);
 * overwritten when the next spec run dispatches.
 */
const specHistoryIds = new Map<string, string>();

function setRun(projectId: string, run: AgentRun | null): void {
  useAgentStore.setState((s) => ({ runs: { ...s.runs, [projectId]: run } }));
}

function getRun(projectId: string): AgentRun | null {
  return useAgentStore.getState().runs[projectId] ?? null;
}

function ensureSubscription(projectId: string): void {
  if (subscribed.has(projectId)) return;
  subscribed.add(projectId);
  backend.subscribe(projectId, (msg) => {
    const historyId = specHistoryIds.get(projectId);
    if (msg.type === "agent-artifacts") {
      const run = getRun(projectId);
      if (run) setRun(projectId, { ...run, artifacts: msg.artifacts });
      // Artifacts can land after exit — attach them to the recorded run too (#104).
      if (historyId) history.update(historyId, { artifacts: msg.artifacts });
      // Close the loop back to the board (#125): stamp each created issue onto
      // the source cards its refs name, so the cards grow link chips.
      canvas.applyIssueLinks(projectId, msg.artifacts);
      return;
    }
    if (msg.type !== "agent-status") return;
    const cur = getRun(projectId) ?? { status: "spawned", output: "" };
    switch (msg.status) {
      case "spawned":
        setRun(projectId, {
          status: "running",
          pid: msg.pid,
          output: "",
          kind: cur.kind,
          // Prefer the backend-echoed format (#120): it survives where the
          // dispatch-time stamp doesn't (refresh, second tab).
          format: msg.format ?? cur.format
        });
        if (historyId && msg.format) history.update(historyId, { format: msg.format });
        break;
      case "stdout":
      case "stderr":
        setRun(projectId, { ...cur, status: "running", output: cur.output + (msg.data ?? "") });
        break;
      case "exit":
        setRun(projectId, { ...cur, status: "exit", code: msg.code });
        // Persist the finished artifact (#104): empty output is recorded as
        // such, so a no-op run is represented clearly in history.
        if (historyId) {
          history.finish(historyId, {
            status: cur.output.trim() ? "done" : "empty",
            output: cur.output,
            exitCode: msg.code
          });
        }
        break;
      case "error":
        log.error("agent.run_error", { project: projectId, data: msg.data });
        setRun(projectId, { ...cur, status: "error", output: cur.output + (msg.data ?? "") });
        if (historyId) {
          history.finish(historyId, { status: "error", output: cur.output + (msg.data ?? "") });
        }
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
  generateSpec(projectId: string, config: TerminalConfig, format: SpecFormat = "prd", opts: SpecOptions = {}): boolean {
    // Ref-annotate the payload only for the create-issues run (#125): the agent
    // names each issue's source cards back, so the artifacts can be stamped
    // onto the originating cards as links. Other formats stay ref-free.
    const withRefs = format === "issues" && !!opts.createIssues;
    const payload = frameSpec(canvas.serializeForHandoff(projectId, { withRefs }), format, opts);
    if (!payload) return false;
    const command = config.agentCommand?.trim() || "claude";

    ensureSubscription(projectId);
    setRun(projectId, { status: "spawned", output: "", kind: "spec", format });
    // Open the run's history entry (#104) — finished from exit/error above, so
    // the artifact can be reopened after the panel closes / the app reloads.
    specHistoryIds.set(projectId, history.record({ projectId, type: "spec", format }));

    backend.connect();
    backend.send({
      type: "agent",
      projectId,
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
    projectId: string,
    text: string,
    intent: PromptIntent = "discuss",
    sourceRefs: readonly string[] = []
  ): boolean {
    if (!ingestion.isAttached(projectId)) return false;
    const prompt = framePrompt(text.trim() ? text : "", intent, sourceRefs);
    if (!prompt) return false;
    // No '\r': the prompt stays editable in the terminal until the user submits.
    ingestion.sendInput(projectId, prompt);
    ingestion.focusTerminal(projectId);
    return true;
  },

  /**
   * Reference in terminal (#194) — type the selected cards into the LIVE session
   * as a plain, verb-free reference block: stable `@refs` plus card content, no
   * preset prompt. Like {@link discussText} it is NOT submitted (no trailing
   * '\r'), so the user types whatever follow-up they want and hits Enter.
   *
   * @returns `true` if the block was typed; `false` if no session is attached or
   *   the selection frames to nothing.
   */
  referenceIdeas(projectId: string, cards: readonly ReferencedIdea[]): boolean {
    if (!ingestion.isAttached(projectId)) return false;
    const block = frameReference(cards);
    if (!block) return false;
    // No '\r': the block stays editable — the user owns the next prompt.
    ingestion.sendInput(projectId, block);
    ingestion.focusTerminal(projectId);
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
  triage(projectId: string): boolean {
    if (!ingestion.isAttached(projectId)) return false;
    const board = canvas.serializeForTriage(projectId);
    const prompt = frameTriage(board);
    if (!prompt) return false;
    // Trailing '\r' submits it — a triage pass is a complete request, not an
    // editable seam like the card verbs.
    ingestion.sendInput(projectId, prompt + "\r");
    ingestion.focusTerminal(projectId);
    // Record the request's metadata (#104): one serialized line per triageable
    // card, so `cardCount` is the denominator the score replies count toward
    // (see history.noteTriageScore in the ingestion pipeline).
    history.record({
      projectId,
      type: "triage",
      cardCount: board.split("\n").filter((line) => line.trim()).length
    });
    return true;
  }
};
