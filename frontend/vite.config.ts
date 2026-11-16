import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// The FastAPI backend. 127.0.0.1 rather than localhost: Node may resolve localhost to ::1.
const backend = process.env.BACKEND_URL ?? 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, ws: true },
    },
  },
  preview: {
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
