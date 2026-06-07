import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 4200,
    // The local backend loop (PRD §4.2). Mirrors the old Angular proxy.conf.json:
    // the multiplexing PTY WebSocket and the health probe both proxy to :8787.
    proxy: {
      '/pty': { target: 'ws://127.0.0.1:8787', ws: true, secure: false },
      '/health': { target: 'http://127.0.0.1:8787', secure: false },
    },
  },
})
