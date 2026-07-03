import { useEffect, useRef, useState } from "react";
import { Loader2, PanelRightOpen } from "lucide-react";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkspaceStore, workspace } from "./stores/workspace.store";
import { backend } from "./stores/backend.store";
import { useUiStore } from "./stores/ui.store";
import { Sidebar } from "./components/Sidebar";
import { CanvasPane } from "./components/CanvasPane";
import { ControlHub } from "./components/ControlHub";
import { SessionStatusDot } from "./components/SessionStatusDot";
import { log } from "@/lib/log";

const HUB_MIN_WIDTH = 320;
const HUB_WIDTH_KEY = "as:hub-width";
const HUB_COLLAPSED_KEY = "as:hub-collapsed";
const HUB_COLLAPSED_WIDTH = 44;

function restoreHubWidth(): number {
  const raw = Number(localStorage.getItem(HUB_WIDTH_KEY));
  return Number.isFinite(raw) && raw >= HUB_MIN_WIDTH ? raw : 424;
}

function restoreHubCollapsed(): boolean {
  return localStorage.getItem(HUB_COLLAPSED_KEY) === "1";
}

/**
 * Root shell (PRD §3.1): a persistent sidebar, the structural workspace canvas
 * (left pane) and the conversational control hub (right pane). Boots the
 * crash-recovery sequence before rendering the panes.
 */
export function App() {
  const booted = useWorkspaceStore((s) => s.booted);
  const [bootError, setBootError] = useState<string | null>(null);
  const focusMode = useUiStore((s) => s.focusMode);

  const [hubWidth, setHubWidth] = useState(restoreHubWidth);
  const hubWidthRef = useRef(hubWidth);
  hubWidthRef.current = hubWidth;

  const [hubCollapsed, setHubCollapsed] = useState(restoreHubCollapsed);

  function toggleHubCollapsed(): void {
    setHubCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(HUB_COLLAPSED_KEY, next ? "1" : "0");
      return next;
    });
  }

  // Boot sequence (PRD §3.5), run once on mount.
  useEffect(() => {
    let cancelled = false;
    workspace
      .boot()
      .then(() => {
        if (!cancelled) backend.connect();
      })
      .catch((err: unknown) => {
        log.error("app.boot_failed", { message: err instanceof Error ? err.message : String(err) });
        if (!cancelled) {
          setBootError("Failed to restore local storage: " + (err instanceof Error ? err.message : String(err)));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function startResize(ev: React.PointerEvent): void {
    ev.preventDefault();
    const handle = ev.currentTarget as HTMLElement;
    handle.setPointerCapture(ev.pointerId);
    const max = () => Math.max(HUB_MIN_WIDTH, window.innerWidth * 0.7);
    const move = (e: PointerEvent) => {
      const w = Math.min(Math.max(window.innerWidth - e.clientX, HUB_MIN_WIDTH), max());
      setHubWidth(Math.round(w));
    };
    const up = () => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      localStorage.setItem(HUB_WIDTH_KEY, String(hubWidthRef.current));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  }

  if (!booted) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
        <Loader2 className="size-7 animate-spin" />
        <p className="text-sm">{bootError ?? "Restoring workspaces…"}</p>
      </div>
    );
  }

  // One derived state instead of four independent `focusMode`/`hubCollapsed`
  // branches below (review #131) — a future edit to the hub's visuals only has
  // one place to touch, not four that can silently drift out of sync.
  const hubVisual = focusMode ? "hidden" : hubCollapsed ? "collapsed" : "expanded";

  return (
    <SidebarProvider className="h-full">
      {/* Unmounted rather than told to close (#131): the sidebar's own state
          (and its global Ctrl/⌘ B shortcut) is left completely alone, so
          whatever the user had before focus mode is exactly what they get
          back on exit — no separate "remember and restore" bookkeeping, and
          no window where Ctrl/⌘ B could reopen it over the fullscreen canvas. */}
      {!focusMode && <Sidebar />}
      <SidebarInset className="min-w-0 overflow-hidden">
        <div className="flex h-full min-h-0">
          <main className="relative min-w-0 flex-1 overflow-hidden bg-card">
            <CanvasPane />
          </main>
          <aside
            className={cn(
              "relative flex min-w-0 flex-col bg-background transition-[width] duration-150 ease-out",
              hubVisual === "hidden" ? "border-l-0" : "border-l"
            )}
            style={{ width: hubVisual === "hidden" ? 0 : hubVisual === "collapsed" ? HUB_COLLAPSED_WIDTH : hubWidth }}
          >
            {hubVisual === "expanded" && (
              <div
                className="absolute -left-1 top-0 bottom-0 z-10 w-2 cursor-col-resize touch-none after:absolute after:left-[3px] after:top-0 after:bottom-0 after:w-px after:bg-transparent hover:after:bg-ring"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize terminal pane"
                onPointerDown={startResize}
              />
            )}
            {hubVisual === "collapsed" && (
              <div className="flex h-full flex-col items-center gap-3 py-2">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Expand control hub"
                  title="Expand control hub"
                  onClick={toggleHubCollapsed}
                >
                  <PanelRightOpen className="size-4" />
                </Button>
                {/* The hub header's session indicator, dot-only, so backend
                    loss or a session error stays visible while collapsed. */}
                <SessionStatusDot />
              </div>
            )}
            {/* Kept mounted while collapsed/focus-hidden (just visually hidden) so
                the live terminal/PTY session isn't torn down and reattached (#109,
                #131). */}
            <div className={cn("min-h-0 flex-1", hubVisual !== "expanded" && "invisible absolute inset-0 -z-10")}>
              <ControlHub onCollapse={toggleHubCollapsed} />
            </div>
          </aside>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
