import { create } from "zustand";
import {
  entriesOverCap,
  historyPreview,
  reconcileStale,
  type RunHistoryEntry,
  type RunHistoryStatus,
  type RunHistoryType
} from "../core/run-history";
import type { AgentArtifact, SpecFormat } from "@ai-storm/shared";
import { backend } from "./backend.store";

interface HistoryState {
  entries: RunHistoryEntry[];
}
interface HistoryWire {
  revision: number;
  runs: RunHistoryEntry[];
}

export const useHistoryStore = create<HistoryState>(() => ({ entries: [] }));

export function projectHistory(entries: readonly RunHistoryEntry[], projectId: string): RunHistoryEntry[] {
  return entries.filter((entry) => entry.projectId === projectId);
}

let booted = false;
interface PendingMutation {
  operation: "history-append" | "history-update" | "history-delete" | "history-clear";
  projectId: string;
  payload?: Record<string, unknown>;
  key: string;
  sequence: number;
}
let mutationSequence = 0;
const pendingMutations = new Map<string, PendingMutation>();
function replaceProject(projectId: string, wire: HistoryWire): void {
  useHistoryStore.setState((state) => ({
    entries: [...state.entries.filter((entry) => entry.projectId !== projectId), ...wire.runs].sort(
      (a, b) => b.createdAt - a.createdAt
    )
  }));
}
function optimistic(entry: RunHistoryEntry): void {
  useHistoryStore.setState((state) => ({
    entries: [entry, ...state.entries.filter((item) => item.id !== entry.id)].sort((a, b) => b.createdAt - a.createdAt)
  }));
}
function find(id: string): RunHistoryEntry | undefined {
  return useHistoryStore.getState().entries.find((entry) => entry.id === id);
}
function mutate(input: Omit<PendingMutation, "sequence">): void {
  const command: PendingMutation = { ...input, sequence: ++mutationSequence };
  void backend
    .request<HistoryWire>(command.operation, { projectId: command.projectId, payload: command.payload })
    .then((wire) => {
      const pending = pendingMutations.get(command.key);
      if (!pending || pending.sequence <= command.sequence) {
        pendingMutations.delete(command.key);
        replaceProject(command.projectId, wire);
      }
    })
    .catch(() => {
      const existing = pendingMutations.get(command.key);
      if (!existing || existing.sequence < command.sequence) pendingMutations.set(command.key, command);
    });
}

async function loadProjects(projectIds: readonly string[]): Promise<void> {
  const uniqueIds = [...new Set(projectIds)];
  const wires = await Promise.all(
    uniqueIds.map(
      async (projectId) => [projectId, await backend.request<HistoryWire>("history-load", { projectId })] as const
    )
  );
  for (const [projectId, wire] of wires) replaceProject(projectId, wire);
  const loaded = uniqueIds.length > 0 ? new Set(uniqueIds) : null;
  for (const entry of useHistoryStore.getState().entries) {
    if (loaded && !loaded.has(entry.projectId)) continue;
    const fixed = reconcileStale(entry);
    if (fixed) patchEntry(entry.id, fixed);
  }
}

async function flushPending(): Promise<void> {
  const failedProjects = new Set<string>();
  for (const command of pendingMutations.values()) {
    if (failedProjects.has(command.projectId)) continue;
    try {
      const wire = await backend.request<HistoryWire>(command.operation, {
        projectId: command.projectId,
        payload: command.payload
      });
      pendingMutations.delete(command.key);
      replaceProject(command.projectId, wire);
    } catch {
      // One deleted/corrupt project must not poison the queue for every other
      // project's durable history. Keep this project ordered for a later retry,
      // while allowing unrelated projects to continue flushing.
      failedProjects.add(command.projectId);
    }
  }
}
backend.onOpen(() => void flushPending());

function patchEntry(id: string, patch: Partial<RunHistoryEntry>): void {
  const current = find(id);
  if (!current) return;
  const next = { ...current, ...patch };
  if (patch.output !== undefined) next.preview = historyPreview(patch.output);
  if (patch.status && patch.status !== "running" && next.finishedAt === undefined) next.finishedAt = Date.now();
  optimistic(next);
  mutate({
    operation: "history-update",
    projectId: next.projectId,
    // Send the fully merged entry. Replacing an older pending update for this
    // id can no longer lose fields from that older patch.
    payload: { entryId: id, patch: { ...next } },
    key: `update:${id}`
  });
}

export const history = {
  async boot(projectIds: readonly string[] = []): Promise<void> {
    if (booted) return;
    booted = true;
    await loadProjects(projectIds);
  },

  /** Load history for projects added after app boot, such as restored backup
   * clones. Import writes the files backend-side; this refreshes the live store. */
  loadProjects,

  record(input: {
    projectId: string;
    type: RunHistoryType;
    status?: RunHistoryStatus;
    output?: string;
    format?: SpecFormat;
    cardCount?: number;
  }): string {
    const id = `run_${crypto.randomUUID()}`;
    const now = Date.now();
    const status = input.status ?? "running";
    const output = input.output ?? "";
    const entry: RunHistoryEntry = {
      id,
      projectId: input.projectId,
      type: input.type,
      status,
      createdAt: now,
      finishedAt: status !== "running" ? now : undefined,
      output,
      preview: historyPreview(output),
      format: input.format,
      cardCount: input.cardCount,
      scoredCount: input.type === "triage" ? 0 : undefined
    };
    optimistic(entry);
    for (const stale of entriesOverCap(projectHistory(useHistoryStore.getState().entries, input.projectId))) {
      useHistoryStore.setState((state) => ({ entries: state.entries.filter((item) => item.id !== stale) }));
    }
    mutate({ operation: "history-append", projectId: input.projectId, payload: { entry }, key: `append:${id}` });
    return id;
  },

  recordSynthesis(projectId: string, output: string, cardCount: number): string {
    const latest = useHistoryStore
      .getState()
      .entries.find((entry) => entry.projectId === projectId && entry.type === "synthesis");
    if (latest && latest.output === output) {
      const now = Date.now();
      patchEntry(latest.id, { createdAt: now, finishedAt: now, cardCount });
      return latest.id;
    }
    return history.record({
      projectId,
      type: "synthesis",
      status: output.trim() ? "done" : "empty",
      output,
      cardCount
    });
  },

  update(id: string, patch: Partial<Pick<RunHistoryEntry, "format" | "artifacts" | "cardCount">>): void {
    patchEntry(id, patch);
  },

  finish(
    id: string,
    result: {
      status: Exclude<RunHistoryStatus, "running">;
      output?: string;
      exitCode?: number;
      artifacts?: AgentArtifact[];
    }
  ): void {
    patchEntry(id, result);
  },

  noteTriageScore(projectId: string): void {
    const entry = useHistoryStore
      .getState()
      .entries.find((item) => item.projectId === projectId && item.type === "triage" && item.status === "running");
    if (!entry) return;
    const scoredCount = (entry.scoredCount ?? 0) + 1;
    const complete = entry.cardCount !== undefined && scoredCount >= entry.cardCount;
    patchEntry(entry.id, complete ? { scoredCount, status: "done" } : { scoredCount });
  },

  remove(id: string): void {
    const entry = find(id);
    if (!entry) return;
    useHistoryStore.setState((state) => ({ entries: state.entries.filter((item) => item.id !== id) }));
    mutate({
      operation: "history-delete",
      projectId: entry.projectId,
      payload: { entryId: id },
      key: `delete:${id}`
    });
  },

  removeProject(projectId: string, persist = true): void {
    useHistoryStore.setState((state) => ({ entries: state.entries.filter((entry) => entry.projectId !== projectId) }));
    for (const [key, command] of pendingMutations) {
      if (command.projectId === projectId) pendingMutations.delete(key);
    }
    if (persist) mutate({ operation: "history-clear", projectId, key: `clear:${projectId}` });
  }
};
