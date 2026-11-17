import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The FastAPI backend. 127.0.0.1 rather than localhost: Node may resolve localhost to ::1.
const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'

// Listen on IPv4 loopback. By default Vite binds "localhost", which can resolve to ::1 only,
// and VPNs with IPv6 leak protection (e.g. Astrill) block ::1, so the page can't be reached.
const host = '127.0.0.1'

export default defineConfig({
  plugins: [react()],
  server: {
    host,
    port: 5173,
    proxy: {
      '/api': { target: backend, ws: true },
    },
  },
  preview: {
    host,
    port: 4173,
    proxy: {
      '/api': { target: backend, ws: true },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
