import { createRoot } from "react-dom/client";
import "./index.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { App } from "./app/App";
import { theme } from "./app/stores/theme.store";
import { initOtel } from "./otel";

if (import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT) {
  void initOtel();
}

// Apply the stored theme choice and follow the OS when set to 'system'. The
// inline script in index.html already painted the right palette before React;
// this re-applies it and wires the live media-query listener (#77).
theme.init();

// NOTE: intentionally no <StrictMode>. The app is built around imperative
// singletons (one multiplexing WebSocket, live xterm.js instances, the tldraw
// Editor, per-workspace IndexedDB stores). StrictMode's deliberate double
// mount/unmount in dev would double-open the socket, re-spawn terminals and
// re-mount tldraw, which these effects are not written to tolerate.
createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <App />
  </TooltipProvider>
);
