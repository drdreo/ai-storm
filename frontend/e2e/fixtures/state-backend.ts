import type { Page, WebSocketRoute } from "@playwright/test";

/**
 * In-memory fake of the backend state protocol (#233) for the backend-free
 * `ui` suite. Since the backend filesystem became the sole durable authority,
 * the app cannot boot without a `/pty` socket answering `state-request`
 * messages — so this fixture intercepts the WebSocket with `routeWebSocket`
 * and serves registry/board/history operations from per-test memory.
 *
 * State lives on the fixture (not the connection), so it survives reloads
 * within a test — mirroring the real backend across two app boots — while
 * every test still starts from a fresh, isolated store, exactly the isolation
 * the per-context IndexedDB stores used to provide.
 *
 * PTY/session traffic is ignored: the `ui` suite never starts sessions, and
 * `/api/*` fetches keep failing through the dev proxy as before.
 */

interface StoredBoard {
  version: 1;
  revision: number;
  nextIdeaRef: number;
  document: unknown;
}

interface StoredHistory {
  version: 1;
  revision: number;
  runs: Array<Record<string, unknown> & { id?: unknown }>;
}

interface StoredRegistry {
  version: 1;
  revision: number;
  projects: Array<Record<string, unknown> & { id: string }>;
  folders: Array<Record<string, unknown> & { id: string }>;
}

interface StateRequest {
  type: "state-request";
  requestId: string;
  operation: string;
  projectId?: string;
  payload?: Record<string, unknown>;
}

const HISTORY_CAP = 50;

export class FakeStateBackend {
  #registry: StoredRegistry = { version: 1, revision: 0, projects: [], folders: [] };
  #boards = new Map<string, StoredBoard>();
  #histories = new Map<string, StoredHistory>();
  #offline = false;
  #live: WebSocketRoute | null = null;

  async install(page: Page): Promise<void> {
    await page.routeWebSocket("**/pty", (ws) => {
      if (this.#offline) {
        ws.close();
        return;
      }
      this.#live = ws;
      ws.onMessage((raw) => this.#onMessage(ws, String(raw)));
    });
  }

  /**
   * Simulate losing the backend after boot: the live socket closes and every
   * reconnect attempt is refused, so the app settles into its offline state.
   */
  setOffline(offline: boolean): void {
    this.#offline = offline;
    if (offline) {
      this.#live?.close();
      this.#live = null;
    }
  }

  #board(projectId: string): StoredBoard {
    let board = this.#boards.get(projectId);
    if (!board) {
      board = { version: 1, revision: 0, nextIdeaRef: 1, document: null };
      this.#boards.set(projectId, board);
    }
    return board;
  }

  #history(projectId: string): StoredHistory {
    let history = this.#histories.get(projectId);
    if (!history) {
      history = { version: 1, revision: 0, runs: [] };
      this.#histories.set(projectId, history);
    }
    return history;
  }

  #bump(): StoredRegistry {
    this.#registry.revision++;
    return this.#registry;
  }

  #onMessage(ws: WebSocketRoute, raw: string): void {
    let msg: StateRequest;
    try {
      msg = JSON.parse(raw) as StateRequest;
    } catch {
      return;
    }
    if (msg?.type !== "state-request") return; // PTY/session traffic is out of scope here.
    try {
      const data = this.#dispatch(msg.operation, msg.projectId, msg.payload ?? {});
      ws.send(
        JSON.stringify({ type: "state-response", requestId: msg.requestId, operation: msg.operation, ok: true, data })
      );
    } catch (error) {
      ws.send(
        JSON.stringify({
          type: "state-response",
          requestId: msg.requestId,
          operation: msg.operation,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  }

  #dispatch(operation: string, projectId: string | undefined, payload: Record<string, unknown>): unknown {
    switch (operation) {
      case "registry-load":
        return this.#registry;
      case "session-probe":
        // The ui suite never starts sessions; nothing survives a reload.
        return { exists: false };
      case "registry-create-project": {
        const project = payload.project as Record<string, unknown> & { id: string; createdAt?: number };
        const createdAt = project.createdAt ?? Date.now();
        this.#registry.projects.push({ ...project, createdAt, updatedAt: createdAt });
        this.#board(project.id);
        this.#history(project.id);
        return this.#bump();
      }
      case "registry-patch-project": {
        const index = this.#registry.projects.findIndex((item) => item.id === projectId);
        if (index < 0) throw new Error(`Project does not exist: ${projectId}`);
        this.#registry.projects[index] = {
          ...this.#registry.projects[index],
          ...(payload.patch as Record<string, unknown>),
          updatedAt: Date.now()
        };
        return this.#bump();
      }
      case "registry-delete-project":
        this.#registry.projects = this.#registry.projects.filter((item) => item.id !== projectId);
        if (projectId) {
          this.#boards.delete(projectId);
          this.#histories.delete(projectId);
        }
        return this.#bump();
      case "registry-create-folder":
        this.#registry.folders.push(payload.folder as Record<string, unknown> & { id: string });
        return this.#bump();
      case "registry-patch-folder": {
        const index = this.#registry.folders.findIndex((item) => item.id === payload.folderId);
        if (index < 0) throw new Error(`Folder does not exist: ${String(payload.folderId)}`);
        this.#registry.folders[index] = {
          ...this.#registry.folders[index],
          ...(payload.patch as Record<string, unknown>)
        };
        return this.#bump();
      }
      case "registry-delete-folder":
        this.#registry.folders = this.#registry.folders.filter((item) => item.id !== payload.folderId);
        this.#registry.projects = this.#registry.projects.map((item) =>
          item.folderId === payload.folderId ? { ...item, folderId: undefined } : item
        );
        return this.#bump();
      case "board-load": {
        const board = this.#board(projectId!);
        return { revision: board.revision, document: board.document };
      }
      case "board-save": {
        const board = this.#board(projectId!);
        if (board.revision !== payload.expectedRevision) {
          return { ok: false, conflict: { revision: board.revision, document: board.document } };
        }
        board.revision++;
        board.document = payload.document;
        return { ok: true, board: { ...board } };
      }
      case "reserve-idea-refs": {
        const board = this.#board(projectId!);
        const count = payload.count as number;
        const refs = Array.from({ length: count }, (_, index) => `i${board.nextIdeaRef + index}`);
        board.nextIdeaRef += count;
        return { refs };
      }
      case "history-load":
        return this.#history(projectId!);
      case "history-append": {
        const history = this.#history(projectId!);
        const entry = payload.entry as Record<string, unknown> & { id?: unknown };
        history.revision++;
        history.runs = [...history.runs.filter((run) => run.id !== entry.id), entry].slice(-HISTORY_CAP);
        return history;
      }
      case "history-update": {
        const history = this.#history(projectId!);
        const index = history.runs.findIndex((run) => run.id === payload.entryId);
        if (index < 0) throw new Error(`History entry does not exist: ${String(payload.entryId)}`);
        history.revision++;
        history.runs[index] = {
          ...history.runs[index],
          ...(payload.patch as Record<string, unknown>),
          id: payload.entryId
        };
        return history;
      }
      case "history-delete": {
        const history = this.#history(projectId!);
        history.revision++;
        history.runs = history.runs.filter((run) => run.id !== payload.entryId);
        return history;
      }
      case "history-clear": {
        const history = this.#history(projectId!);
        history.revision++;
        history.runs = [];
        return history;
      }
      default:
        throw new Error(`Unsupported state operation: ${operation}`);
    }
  }
}
