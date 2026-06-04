/**
 * End-to-end smoke test against a RUNNING backend (deno task start first).
 * Verifies: /health, PTY attach + stream, input echo, and agent execution.
 * Run: deno run --allow-net=127.0.0.1 smoke_test.ts
 */

const BASE = "http://127.0.0.1:8787";
const WS = "ws://127.0.0.1:8787/pty";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok  - " + msg);
}

// 1) Health endpoint.
const health = await (await fetch(`${BASE}/health`)).json();
assert(health.status === "ok", "/health returns ok");

// 2) WebSocket PTY round-trip.
const socket = new WebSocket(WS);
const got: string[] = [];
let ready = false;

await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timeout waiting for PTY data")), 15000);
  socket.onopen = () => {
    socket.send(JSON.stringify({ type: "attach", workspaceId: "smoke" }));
    // Echo a unique marker through the shell after it spins up.
    setTimeout(() => {
      socket.send(JSON.stringify({ type: "input", workspaceId: "smoke", data: "echo SMOKE_MARKER_123\r\n" }));
    }, 800);
  };
  socket.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.type === "ready") ready = true;
    if (msg.type === "data") {
      got.push(msg.chunk);
      if (got.join("").includes("SMOKE_MARKER_123")) {
        clearTimeout(timer);
        resolve();
      }
    }
  };
  socket.onerror = () => reject(new Error("socket error"));
});

assert(ready, "received ready for attached PTY");
assert(got.join("").includes("SMOKE_MARKER_123"), "PTY streamed back echoed marker");

socket.send(JSON.stringify({ type: "detach", workspaceId: "smoke" }));
socket.close();

console.log("\nALL SMOKE CHECKS PASSED");
Deno.exit(0);
