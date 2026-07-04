/**
 * End-to-end smoke test against a RUNNING backend (pnpm start first).
 * Verifies: /health, durable session attach, raw `data` passthrough.
 * Run: node smoke_test.ts   (uses Node's global fetch + WebSocket)
 *
 * Drives a deterministic interactive REPL (bash) rather than a real AI harness:
 * we attach a `bash` session, send `echo SMOKE_MARKER_123\r`, and assert the
 * marker comes back in the raw `data` stream (base64-decoded) — the conversation
 * surface is now a real terminal, so output arrives as bytes, not pre-split chat.
 */

const BASE = "http://127.0.0.1:8787";
const WS = "ws://127.0.0.1:8787/pty";
const PROJECT = "smoke";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok  - " + msg);
}

// 1) Health endpoint.
const health = await (await fetch(`${BASE}/health`)).json();
assert(health.status === "ok", "/health returns ok");

// 2) WebSocket session round-trip via the raw data stream.
const socket = new WebSocket(WS);
let terminal = "";
let attached = false;

await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout waiting for data")), 20000);
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "attach", projectId: PROJECT, shell: "bash" }));
    setTimeout(() => {
      socket.send(JSON.stringify({ type: "input", projectId: PROJECT, data: "echo SMOKE_MARKER_123\r" }));
    }, 1200);
  };
  socket.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === "session-status" && msg.status === "attached") attached = true;
    if (msg.type === "data") {
      terminal += Buffer.from(msg.data, "base64").toString("utf8");
      if (terminal.includes("SMOKE_MARKER_123")) {
        clearTimeout(timer);
        resolve();
      }
    }
  };
  socket.onerror = () => reject(new Error("socket error"));
});

assert(attached, "received session-status attached");
assert(terminal.includes("SMOKE_MARKER_123"), "raw data stream carried the marker");

// Tear the durable session down so the smoke run leaves nothing behind.
socket.send(JSON.stringify({ type: "kill", projectId: PROJECT }));
await new Promise((r) => setTimeout(r, 300));
socket.close();

console.log("\nALL SMOKE CHECKS PASSED");
process.exit(0);
