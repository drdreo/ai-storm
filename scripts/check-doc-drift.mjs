#!/usr/bin/env node
/**
 * Lightweight documentation drift audit for the implementation-owned seams.
 *
 * This is intentionally a checklist, not a guessed natural-language linter:
 * the assertions name the source files and status claims that are easy to leave
 * stale after an architectural change. Keep the checks small and update them
 * when a documented contract deliberately moves.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const documents = new Map();

function readDocument(relativePath) {
  const absolutePath = resolve(root, relativePath);
  try {
    const text = readFileSync(absolutePath, "utf8");
    documents.set(relativePath, text);
    return text;
  } catch (error) {
    failures.push(`${relativePath}: unable to read (${error.message})`);
    return "";
  }
}

function check(label, ok, detail) {
  if (ok) {
    console.log(`PASS  ${label}`);
  } else {
    failures.push(`${label}: ${detail}`);
    console.log(`FAIL  ${label}`);
  }
}

function hasEvery(text, needles) {
  return needles.every((needle) => text.includes(needle));
}

function checkEncoding(relativePath, text) {
  const mojibake = /[\uFFFD]|(?:Ã[\u0080-\u00BF])|(?:Â[\u0080-\u00BF])|(?:â€)|(?:ðŸ)/u;
  check(
    `${relativePath}: UTF-8 text is clean`,
    !text.startsWith("\uFEFF") && text.normalize("NFC") === text && !mojibake.test(text),
    "remove a BOM, replacement character, or common UTF-8-as-Windows-1252 artifact"
  );
}

function checkLocalLinks(relativePath, text) {
  const linkPattern = /\]\(([^)]+)\)/g;
  let match;
  while ((match = linkPattern.exec(text)) !== null) {
    const destination = match[1].trim().split(/\s+/u, 1)[0];
    if (
      !destination ||
      destination.startsWith("#") ||
      destination.startsWith("/") ||
      /^(?:https?:|mailto:|data:)/iu.test(destination)
    ) {
      continue;
    }
    const pathOnly = decodeURIComponent(destination.split("#", 1)[0].split("?", 1)[0]);
    if (!pathOnly) continue;
    const target = resolve(root, dirname(relativePath), pathOnly);
    check(`${relativePath}: link ${destination}`, existsSync(target), `target does not exist: ${pathOnly}`);
  }
}

const readme = readDocument("README.md");
const mcp = readDocument("docs/design/mcp-idea-capture.md");
const graph = readDocument("docs/design/idea-graph.md");
const sessions = readDocument("docs/design/ai-session-layer.md");
const extraction = readDocument("docs/design/ai-response-extraction-contract.md");
const history = readDocument("docs/pd-run-history.md");
const decisions = readDocument("docs/decisions/product-decisions.md");
const architecture = readDocument("docs/media/architecture.svg");

for (const [relativePath, text] of documents) {
  if (extname(relativePath).toLowerCase() === ".md") {
    checkEncoding(relativePath, text);
    checkLocalLinks(relativePath, text);
  }
}

check(
  "README: backend-owned persistence is documented",
  hasEvery(readme, [
    "The backend is the source of truth",
    "registry.json",
    "projects/<project-id>/board.json",
    "projects/<project-id>/history.json",
    "active project pointer"
  ]) && !readme.includes("persisted to IndexedDB"),
  "describe StateStore files rather than the retired browser IndexedDB/Yjs stores"
);

check(
  "MCP design: live implementation status and tool surface",
  /\*\*Status:\*\*[^\n]*Implemented/u.test(mcp) &&
    hasEvery(mcp, [
      "backend/src/mcp/endpoint.ts",
      "POST /mcp/:projectId/:token",
      "capture_idea",
      "capture_score",
      "mark_idea_done",
      "link_idea",
      "get_board_ideas",
      "get_projects"
    ]) &&
    !mcp.includes("Schemas are the single source of truth (zod backend-side"),
  "keep the MCP design aligned with the shipped hand-rolled endpoint and all shipped tools"
);

check(
  "Idea graph: backend-owned graph persistence is documented",
  /\*\*Status:\*\*[^\n]*Implemented/u.test(graph) &&
    hasEvery(graph, ["backend/src/state/store.ts", "board-save", "projects/<project-id>/board.json"]) &&
    !graph.includes("persistenceKey` → IndexedDB") &&
    !graph.includes("No server-side graph store."),
  "describe the tldraw document as a backend-owned board snapshot, not browser IndexedDB"
);

check(
  "Session design: durable runtime matches source",
  hasEvery(sessions, [
    "backend/src/session/runtime.ts",
    "backend/src/session/tmux-backend.ts",
    "backend/src/session/nodepty-backend.ts",
    "backend/src/state/store.ts",
    "raw PTY bytes"
  ]) &&
    !sessions.includes("Today the backend spawns the agent **directly** under a per-connection") &&
    !sessions.includes("There is **no named session, no reattach, no persistence**"),
  "mark the old per-connection PTY proposal as historical and document the shipped runtime"
);

check(
  "Run history: storage matches source",
  hasEvery(history, ["backend/src/state/store.ts", "history.json", "history-append"]) &&
    !history.includes("No backend involvement") &&
    !history.includes("IndexedDB-only"),
  "document backend StateStore history files and the state protocol"
);

check(
  "Product decisions: current persistence decision is explicit",
  hasEvery(decisions, ["### PD-024 — Backend-owned durable project state", "StateStore", "board.json", "history.json"]),
  "add a current decision that supersedes the browser-only persistence wording"
);

check(
  "Extraction contract: current source links are valid",
  hasEvery(extraction, [
    "backend/src/session/extraction/index.ts",
    "frontend/src/app/stores/ingestion.store.ts",
    "frontend/src/app/components/Terminal.tsx"
  ]) && !extraction.includes("backend/src/session/extraction.ts`"),
  "point the superseded-design banner at the current module paths"
);

check(
  "Architecture media: generated diagram is present",
  existsSync(resolve(root, "docs/media/architecture.png")) &&
    hasEvery(architecture, ["BACKEND-OWNED DURABLE STATE", "StateStore", "MCP CAPTURE", "node-pty"]),
  "regenerate architecture.svg and architecture.png from the current topology"
);

if (failures.length > 0) {
  console.error("\nDocumentation drift audit failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("\nDocumentation drift audit passed.");
}
