import { expect, test } from '@playwright/test'
import { installFakeSpeech } from './fakeSpeech'

// The second e2e server (see playwright.config.ts) transcribes with a scripted stand-in for
// Deepgram Flux: the real microphone pipeline runs (audio worklet, 16 kHz PCM over the speech
// socket, the server's relay), and once the app has listened for 0.8 s the service "hears" the
// next scripted turn, word by word, and then says the turn is over.
test.use({ baseURL: `http://127.0.0.1:${Number(process.env.E2E_PORT ?? 8765) + 1}` })

const FIRST = "Hello, I'm Ross, and I move data into SQL Server warehouses."
const SECOND = 'We could start in March.'

interface Stored {
  messages: { role: string; kind: string; content: string }[]
}

interface Heard {
  keyterms: string[]
  frame_sizes: number[]
  frames_while_listening: number
  nonzero_frames_while_paused: number
}

test('with Deepgram, the microphone streams to the server and each turn ends when the speaker is done', async ({
  page,
  request,
}) => {
  await page.addInitScript(installFakeSpeech) // the client's voice; recognition comes from the server
  await page.goto('/')
  await page.getByRole('button', { name: 'Load an example' }).click()
  await page.getByLabel('Your name').fill('Ross Yeager')
  const created = page.waitForResponse((r) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Prepare the meeting' }).click()
  const session = (await (await created).json()) as { id: string; speech_engine: string }
  expect(session.speech_engine).toBe('deepgram')
  await page.getByRole('button', { name: 'Join the meeting' }).click()

  // The client opens; then the participant's two turns arrive, each answered by the client.
  const yours = page.locator('.transcript__list .transcript__entry--you')
  await expect(yours.first()).toContainText(FIRST, { timeout: 15_000 })
  await expect(page.locator('.transcript__list')).toContainText("That's helpful, thank you.")
  await expect(yours.nth(1)).toContainText(SECOND, { timeout: 15_000 })
  await expect(yours.nth(1)).not.toHaveClass(/is-pending/) // the server saved it

  const stored = (await (await request.get(`/api/sessions/${session.id}`)).json()) as Stored
  expect(stored.messages.filter((m) => m.kind === 'speech').map((m) => m.content)).toEqual([FIRST, SECOND])

  const heard = (await (await request.get('/api/e2e/speech')).json()) as Heard
  expect(heard.frame_sizes).toEqual([2560]) // 80 ms of 16 kHz, 16-bit mono audio per frame
  expect(heard.frames_while_listening).toBeGreaterThan(0)
  expect(heard.nonzero_frames_while_paused).toBe(0) // only silence leaves the page while not listening
  expect(heard.keyterms).toEqual(expect.arrayContaining(['Ross Yeager', 'Ross', 'Morgan Reyes', 'Northwind Freight', 'SQL Server']))
})
