import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './app/App'

// NOTE: intentionally no <StrictMode>. The app is built around imperative
// singletons (one multiplexing WebSocket, live xterm.js instances, the tldraw
// Editor, per-workspace IndexedDB stores). StrictMode's deliberate double
// mount/unmount in dev would double-open the socket, re-spawn terminals and
// re-mount tldraw, which these effects are not written to tolerate (this is the
// faithful translation of the old zoneless, single-bootstrap Angular app).
createRoot(document.getElementById('root')!).render(<App />)
