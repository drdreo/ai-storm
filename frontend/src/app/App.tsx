import { useEffect, useRef, useState } from 'react'
import { useWorkspaceStore, workspace } from './stores/workspace.store'
import { backend } from './stores/backend.store'
import { Sidebar } from './components/Sidebar'
import { CanvasPane } from './components/CanvasPane'
import { ControlHub } from './components/ControlHub'

const HUB_MIN_WIDTH = 320
const HUB_WIDTH_KEY = 'as:hub-width'

function restoreHubWidth(): number {
  const raw = Number(localStorage.getItem(HUB_WIDTH_KEY))
  return Number.isFinite(raw) && raw >= HUB_MIN_WIDTH ? raw : 424
}

/**
 * Root shell (PRD §3.1): a persistent sidebar, the structural workspace canvas
 * (left pane) and the conversational control hub (right pane). Boots the
 * crash-recovery sequence before rendering the panes.
 */
export function App() {
  const booted = useWorkspaceStore((s) => s.booted)
  const [bootError, setBootError] = useState<string | null>(null)

  // Resizable terminal (hub) pane. Width drives the grid column; the terminal's
  // own ResizeObserver refits xterm + re-sends cols/rows on change.
  const [hubWidth, setHubWidth] = useState(restoreHubWidth)
  const hubWidthRef = useRef(hubWidth)
  hubWidthRef.current = hubWidth

  // Boot sequence (PRD §3.5), run once on mount.
  useEffect(() => {
    let cancelled = false
    workspace
      .boot()
      .then(() => {
        if (!cancelled) backend.connect()
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBootError(
            'Failed to restore local storage: ' +
              (err instanceof Error ? err.message : String(err)),
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  function startResize(ev: React.PointerEvent): void {
    ev.preventDefault()
    const handle = ev.currentTarget as HTMLElement
    handle.setPointerCapture(ev.pointerId)
    const max = () => Math.max(HUB_MIN_WIDTH, window.innerWidth * 0.7)
    const move = (e: PointerEvent) => {
      const w = Math.min(Math.max(window.innerWidth - e.clientX, HUB_MIN_WIDTH), max())
      setHubWidth(Math.round(w))
    }
    const up = () => {
      handle.releasePointerCapture(ev.pointerId)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      localStorage.setItem(HUB_WIDTH_KEY, String(hubWidthRef.current))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  }

  if (!booted) {
    return (
      <div className="grid h-full place-content-center justify-items-center gap-6 text-text-dim [background:radial-gradient(120%_80%_at_50%_0%,var(--panel-bg)_0%,var(--bg)_60%)]">
        <div className="as-spinner" />
        <p className="m-0 text-[0.9rem] tracking-[0.01em]">
          {bootError ?? 'Restoring workspaces…'}
        </p>
      </div>
    )
  }

  return (
    <div
      className="grid h-full bg-bg"
      style={{ gridTemplateColumns: `244px 1fr ${hubWidth}px` }}
    >
      <Sidebar />
      {/* The light canvas is the focal plane — lift it above the dark shell. */}
      <main className="relative z-[1] min-w-0 overflow-hidden bg-canvas [box-shadow:-8px_0_24px_-12px_rgba(0,0,0,0.55),8px_0_24px_-12px_rgba(0,0,0,0.55)]">
        <CanvasPane />
      </main>
      <aside className="relative flex min-w-0 flex-col border-l border-border-strong bg-panel">
        <div
          className="as-resize-handle absolute -left-1 top-0 bottom-0 z-[5] w-2 cursor-col-resize touch-none"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize terminal pane"
          onPointerDown={startResize}
        />
        <ControlHub />
      </aside>
    </div>
  )
}
