import { defineConfig } from '@playwright/test'

// End-to-end tests run the real FastAPI app (serving the production build) with a scripted
// stand-in for Claude, in the installed Google Chrome. Build the frontend first:
//   npm run build && npm run test:e2e
// Two servers run: one where the browser transcribes speech, and one (port + 1) where a scripted
// stand-in for Deepgram does, behind the real microphone pipeline (e2e/deepgram.spec.ts).
const port = Number(process.env.E2E_PORT ?? 8765)
const python =
  process.env.E2E_PYTHON ?? (process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python')

const server = (serverPort: number, speech: 'browser' | 'scripted') => ({
  command: `${python} -m tests.e2e_server --port ${serverPort} --speech ${speech}`,
  cwd: '../backend',
  url: `http://127.0.0.1:${serverPort}/api/health`,
  reuseExistingServer: false,
  timeout: 30_000,
})

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: process.env.E2E_CHANNEL ?? 'chrome',
    headless: true,
    permissions: ['microphone'],
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
    trace: 'retain-on-failure',
  },
  webServer: [server(port, 'browser'), server(port + 1, 'scripted')],
})
