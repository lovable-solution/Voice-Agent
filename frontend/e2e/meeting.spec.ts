import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { installFakeSpeech } from './fakeSpeech'

const shots = process.env.SCREENSHOT_DIR

async function snap(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false })
}

type SpeechWindow = {
  __speech: {
    listening: boolean
    say(text: string): Promise<void>
    hear(text: string, isFinal: boolean): void
    wordMs: number
    spoken: string[]
    finalOnStop: string | null
  }
}

async function waitUntilListening(page: Page) {
  await page.waitForFunction(() => (window as unknown as SpeechWindow).__speech.listening)
}

/** Speak a whole sentence (interim results, then the final one). */
async function say(page: Page, text: string) {
  await waitUntilListening(page)
  await page.evaluate((t) => (window as unknown as SpeechWindow).__speech.say(t), text)
}

/** One recognition result, for checking the live subtitle mid-sentence. */
async function hear(page: Page, text: string, isFinal: boolean) {
  await page.evaluate(([t, f]) => (window as unknown as SpeechWindow).__speech.hear(t as string, f as boolean), [text, isFinal])
}

async function setWordMs(page: Page, ms: number) {
  await page.evaluate((v) => ((window as unknown as { __speech: { wordMs: number } }).__speech.wordMs = v), ms)
}

async function prepareMeeting(page: Page) {
  await page.addInitScript(installFakeSpeech)
  // A longer end-of-turn pause keeps mid-sentence checks independent of test timing.
  await page.addInitScript(() =>
    localStorage.setItem('client-meeting-simulator.preferences.v1', JSON.stringify({ endOfTurnMs: 2000 })),
  )
  await page.goto('/')
  await page.getByRole('button', { name: 'Load an example' }).click()
  await page.getByLabel('Your name').fill('Alex Kim')
  await page.getByText('Skeptical', { exact: true }).click()
  await snap(page, '1-setup')
  const created = page.waitForResponse((r) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Prepare the meeting' }).click()
  const session = (await (await created).json()) as { id: string }
  await expect(page.getByRole('heading', { name: 'Morgan Reyes' })).toBeVisible()
  return session.id
}

test('a full meeting: briefing, spoken turns with subtitles, interrupting, sharing, transcript', async ({ page, request }) => {
  const sessionId = await prepareMeeting(page)

  // The briefing shows what the client learned; questions stay hidden until revealed.
  await expect(page.getByText('Budget is €45,000–€55,000 fixed price')).toBeVisible()
  await expect(page.getByText('What similar platform have you built?')).toBeHidden()
  await page.getByRole('button', { name: 'Reveal' }).click()
  await expect(page.getByText('What similar platform have you built?')).toBeVisible()
  await snap(page, '2-briefing')
  await page.getByRole('button', { name: 'Join the meeting' }).click()

  // The client opens the meeting; subtitles follow the voice.
  const captions = page.getByTestId('captions')
  const transcript = page.locator('.transcript__list')
  const status = page.locator('.status-line')
  await expect(captions).toContainText('Hi Alex, thanks for making the time.')
  await snap(page, '3-client-speaking')
  await expect(status).toHaveText('Your turn. Go ahead and speak.')

  // Speak a turn: your words appear as a live subtitle while you talk, then the client answers.
  await waitUntilListening(page)
  await hear(page, 'I have built two', false)
  await expect(captions).toContainText('I have built two')
  await expect(status).toHaveText('Listening… pause when you’re done.')
  await hear(page, 'I have built two logistics dashboards in React', true)
  await expect(captions).toContainText('I have built two logistics dashboards in React')
  await expect(captions).toContainText('What similar project have you delivered')
  await expect(transcript).toContainText('I have built two logistics dashboards in React')
  await expect(status).toHaveText('Your turn. Go ahead and speak.')
  await expect(transcript).toContainText("That's helpful, thank you.")

  // Interrupt a long answer: only what was heard is kept, on screen and on the server.
  await setWordMs(page, 220)
  await say(page, 'Can you explain the whole scope')
  await expect(page.getByRole('button', { name: 'Interrupt' })).toBeEnabled()
  await expect(captions).toContainText('Sure, let me walk you through the whole scope.')
  await page.waitForTimeout(900)
  await snap(page, '4-mid-sentence')
  await page.keyboard.press('Escape')
  await expect(transcript.locator('.tag--warn', { hasText: 'interrupted' })).toBeVisible()
  await expect(status).toHaveText('Your turn. Go ahead and speak.')

  const stored = (await (await request.get(`/api/sessions/${sessionId}`)).json()) as {
    messages: { role: string; content: string; interrupted: boolean }[]
  }
  const cut = stored.messages.filter((m) => m.role === 'assistant').at(-1)!
  const heard = cut.content.slice(0, -1)
  const fullReply = 'Sure, let me walk you through the whole scope. First, the booking flow'
  expect(cut.interrupted).toBe(true)
  expect(cut.content.endsWith('—')).toBe(true)
  expect(heard.length).toBeGreaterThan(5) // a few words were spoken...
  expect(fullReply.startsWith(heard)).toBe(true) // ...and only those are kept
  const shown = await transcript.locator('.transcript__entry--client').last().locator('.transcript__text').textContent()
  expect(shown).toBe(heard) // the transcript matches what the server kept

  // Share a document mid-meeting: the client reads it and reacts.
  await setWordMs(page, 40)
  await page.getByRole('tab', { name: 'Share' }).click()
  await page.getByLabel('Title').fill('Pilot plan')
  await page.getByRole('textbox', { name: 'Content' }).fill('Pilot with three partner agents for one quarter, then review together.')
  await page.getByRole('button', { name: 'Share with Morgan' }).click()
  await expect(transcript).toContainText('shared “Pilot plan” · Partnership ideas')
  await expect(captions).toContainText('Thanks for sending that over.')
  await expect(status).toHaveText('Your turn. Go ahead and speak.')
  await snap(page, '5-after-share')

  // Typed replies work too.
  await page.getByPlaceholder('Type instead of speaking…').fill('Happy to cover support myself.')
  await page.keyboard.press('Enter')
  await expect(transcript.locator('.transcript__entry--you').last()).toContainText('Happy to cover support myself.')
  await expect(transcript.locator('.tag', { hasText: 'typed' })).toBeVisible()
  await expect(status).toHaveText('Your turn. Go ahead and speak.')

  // Every sentence the client spoke went through the voice.
  const spoken = await page.evaluate(() => (window as unknown as { __speech: { spoken: string[] } }).__speech.spoken)
  expect(spoken).toContain('Hi Alex, thanks for making the time.')
  expect(spoken).toContain('Thanks for sending that over.')

  // Leave and download the transcript.
  await page.getByRole('button', { name: 'Leave' }).click()
  await expect(page.getByText('Meeting ended')).toBeVisible()
  await snap(page, '6-ended')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download transcript' }).click()
  const markdown = await readFile((await (await download).path())!, 'utf8')
  expect(markdown).toContain('# Discovery call: customer tracking portal')
  expect(markdown).toContain('**Morgan Reyes:** Hi Alex, thanks for making the time.')
  expect(markdown).toContain('**Alex Kim:** I have built two logistics dashboards in React')
  expect(markdown).toContain('_Alex Kim shared “Pilot plan” (partnership ideas)._')
  expect(markdown).toContain('—') // the interrupted turn is marked
})

test('with headphones mode on, speaking over the client interrupts them', async ({ page }) => {
  await prepareMeeting(page)
  await page.getByRole('button', { name: 'Join the meeting' }).click()
  const captions = page.getByTestId('captions')
  await expect(page.locator('.status-line')).toHaveText('Your turn. Go ahead and speak.')

  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByText('I’m wearing headphones').click()
  await page.getByRole('button', { name: 'Close settings' }).click()

  await setWordMs(page, 220)
  await say(page, 'Please explain the scope')
  await expect(captions).toContainText('Sure, let me walk you through')
  await say(page, 'Sorry to jump in quickly')
  await expect(page.locator('.transcript__list .tag--warn', { hasText: 'interrupted' })).toBeVisible()
  await expect(page.locator('.transcript__list')).toContainText('Sorry to jump in quickly')
})

test('a turn that ends on an unfinished guess is sent with the final words', async ({ page, request }) => {
  const sessionId = await prepareMeeting(page)
  await page.getByRole('button', { name: 'Join the meeting' }).click()
  await expect(page.locator('.status-line')).toHaveText('Your turn. Go ahead and speak.')
  await waitUntilListening(page)

  // Recognition's final result corrects its guess, but only arrives once it is asked to finalize.
  await page.evaluate(() => ((window as unknown as SpeechWindow).__speech.finalOnStop = 'We could start in March.'))
  await hear(page, 'we could start in much', false)

  const yours = page.locator('.transcript__list .transcript__entry--you').last()
  await expect(yours).toContainText('We could start in March.')
  await expect(yours).not.toHaveClass(/is-pending/) // the server saved it
  const stored = (await (await request.get(`/api/sessions/${sessionId}`)).json()) as {
    messages: { role: string; kind: string; content: string }[]
  }
  expect(stored.messages.filter((m) => m.kind === 'speech').at(-1)?.content).toBe('We could start in March.')
})

test('muting the microphone and the keyboard shortcut', async ({ page }) => {
  await prepareMeeting(page)
  await page.getByRole('button', { name: 'Join the meeting' }).click()
  await expect(page.locator('.status-line')).toHaveText('Your turn. Go ahead and speak.')

  await page.keyboard.press('m')
  await expect(page.locator('.status-line')).toHaveText('Your turn. Your mic is off: unmute or type a reply.')
  await expect(page.getByRole('button', { name: 'Unmute' })).toBeVisible()
  await page.getByRole('button', { name: 'Unmute' }).click()
  await expect(page.locator('.status-line')).toHaveText('Your turn. Go ahead and speak.')
})
