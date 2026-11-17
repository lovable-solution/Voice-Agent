import { beforeEach, describe, expect, it } from 'vitest'
import type { Recognizer, RecognizerEvents } from '../speech/recognizer'
import type { SpeakItem, Synthesizer, SynthesizerEvents } from '../speech/synthesizer'
import type { ClientEvent, ServerEvent, SessionOut } from '../types'
import { FINAL_RESULT_WAIT_MS, MeetingController, type Timers } from './controller'
import type { ConnectionState, MeetingTransport, TransportEvents } from './transport'

// ------------------------------------------------------------------ fakes

class FakeTransport implements MeetingTransport {
  events!: TransportEvents
  sent: ClientEvent[] = []
  closed = false
  setEvents(events: TransportEvents) {
    this.events = events
  }
  connect() {
    this.events.onState('open')
  }
  send(event: ClientEvent) {
    this.sent.push(event)
  }
  close() {
    this.closed = true
  }
  emit(event: ServerEvent) {
    this.events.onEvent(event)
  }
  state(state: ConnectionState, code?: number) {
    this.events.onState(state, code)
  }
  types() {
    return this.sent.map((e) => e.type)
  }
}

class FakeSynth implements Synthesizer {
  supported = true
  events!: SynthesizerEvents
  queue: SpeakItem[] = []
  current: SpeakItem | null = null
  spoken: string[] = []
  cancels = 0
  setEvents(events: SynthesizerEvents) {
    this.events = events
  }
  configure() {}
  speak(item: SpeakItem) {
    this.queue.push(item)
    if (!this.current) this.next()
  }
  cancel() {
    this.queue = []
    this.current = null
    this.cancels++
  }
  progress(chars: number) {
    this.events.onProgress(this.current!, chars)
  }
  finishOne() {
    const item = this.current!
    this.current = null
    this.spoken.push(item.text)
    this.events.onEnd(item)
    if (!this.current) this.next()
  }
  finishAll() {
    while (this.current) this.finishOne()
  }
  private next() {
    this.current = this.queue.shift() ?? null
    if (this.current) this.events.onStart(this.current)
  }
}

class FakeRecognizer implements Recognizer {
  supported = true
  detectsTurnEnd = false
  lang = 'en-US'
  running = false
  prepared = false
  disposed = false
  endOfTurnMs: number | null = null
  events!: RecognizerEvents
  setEvents(events: RecognizerEvents) {
    this.events = events
  }
  finalizeCalls = 0
  prepare() {
    this.prepared = true
  }
  start() {
    this.running = true
  }
  stop() {
    this.running = false
  }
  finalize() {
    this.finalizeCalls++
  }
  setEndOfTurnMs(ms: number) {
    this.endOfTurnMs = ms
  }
  dispose() {
    this.running = false
    this.disposed = true
  }
  hear(finalText: string, interimText = '') {
    this.events.onResult(finalText, interimText)
  }
}

/** Like Deepgram Flux: transcripts cover the whole turn so far, and it says when the turn ends. */
class FakeTurnRecognizer extends FakeRecognizer {
  detectsTurnEnd = true
  /** The turn so far. */
  update(transcript: string) {
    this.events.onResult('', transcript)
  }
  endTurn(transcript: string) {
    this.events.onTurnEnd(transcript)
  }
}

class FakeTimers implements Timers {
  private time = 0
  private seq = 0
  private tasks = new Map<number, { at: number; fn: () => void }>()
  setTimeout(fn: () => void, ms: number) {
    const id = ++this.seq
    this.tasks.set(id, { at: this.time + ms, fn })
    return id
  }
  clearTimeout(id: unknown) {
    this.tasks.delete(id as number)
  }
  advance(ms: number) {
    const until = this.time + ms
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      this.tasks.delete(due[0])
      this.time = due[1].at
      due[1].fn()
    }
    this.time = until
  }
}

// ------------------------------------------------------------------ fixtures

function session(overrides: Partial<SessionOut> = {}): SessionOut {
  return {
    id: 'ses_1',
    created_at: '2026-01-01T00:00:00Z',
    user_name: 'Alex',
    personality: 'neutral',
    briefing: {
      persona: { name: 'Jordan Lee', role: 'Head of Product', company: 'FinFlow', company_summary: '', communication_style: '' },
      meeting_title: 'Discovery call',
      situation: '',
      project_summary: '',
      partnership_summary: '',
      key_facts: [],
      priorities: [],
      concerns: [],
      questions_to_ask: [],
      agenda: [],
      opening_line: 'Hi Alex.',
      speech_keyterms: [],
    },
    materials: [],
    messages: [],
    speech_engine: 'browser',
    ...overrides,
  }
}

let transport: FakeTransport
let synth: FakeSynth
let recognizer: FakeRecognizer
let timers: FakeTimers
let meeting: MeetingController

function setup(options: { bargeIn?: boolean; endOfTurnMs?: number } = {}, base = session(), rec = new FakeRecognizer()) {
  transport = new FakeTransport()
  synth = new FakeSynth()
  recognizer = rec
  timers = new FakeTimers()
  meeting = new MeetingController({ session: base, transport, synthesizer: synth, recognizer, timers, options })
  meeting.join()
}

const snap = () => meeting.getSnapshot()

function reply(id: string, text: string, { end = true } = {}) {
  transport.emit({ type: 'assistant_start', message_id: id })
  transport.emit({ type: 'assistant_delta', message_id: id, text })
  if (end) transport.emit({ type: 'assistant_end', message_id: id, text, error: null })
}

function startMeeting() {
  transport.emit({ type: 'ready', session: session() })
  reply('m_open', 'Hi Alex, thanks for joining. Shall we start?')
  synth.finishAll()
}

let savedSeq = 0

/** The server's acknowledgement of a participant turn (always sent before its reply starts). */
function ack(content: string, kind: 'speech' | 'typed' = 'speech') {
  transport.emit({
    type: 'message_saved',
    message: { id: `u${++savedSeq}`, role: 'user', kind, content, interrupted: false, material_id: null, created_at: '' },
  })
}

/** Speak a turn, wait out the end-of-turn pause, and have the server save it. */
function say(text: string) {
  recognizer.hear(text)
  timers.advance(1200)
  ack(text)
}

// ------------------------------------------------------------------ tests

describe('MeetingController', () => {
  beforeEach(() => setup())

  it('starts the meeting once the socket is ready and speaks the opening sentence by sentence', () => {
    transport.emit({ type: 'ready', session: session() })
    expect(transport.sent).toEqual([{ type: 'start' }])
    expect(snap().phase).toBe('client_thinking')

    reply('m_open', 'Hi Alex, thanks for joining. Shall we start?')
    expect(snap().phase).toBe('client_speaking')
    expect(snap().caption).toEqual({ speaker: 'client', text: 'Hi Alex, thanks for joining.', spokenChars: 0 })

    synth.progress(8)
    expect(snap().caption?.spokenChars).toBe(8)
    expect(snap().transcript[0]).toMatchObject({ speaker: 'client', text: 'Hi Alex,', pending: true })
    expect(recognizer.running).toBe(false) // never listen over the client's voice

    synth.finishAll()
    expect(synth.spoken).toEqual(['Hi Alex, thanks for joining.', 'Shall we start?'])
    expect(snap().phase).toBe('your_turn')
    expect(snap().transcript[0]).toMatchObject({ text: 'Hi Alex, thanks for joining. Shall we start?', pending: false })
    expect(recognizer.running).toBe(true)
  })

  it('sends what the participant said after a pause', () => {
    startMeeting()
    recognizer.hear('', 'I have built')
    expect(snap().phase).toBe('you_speaking')
    expect(snap().caption).toEqual({ speaker: 'you', text: 'I have built', spokenChars: 0 })

    recognizer.hear('I have built three dashboards.', '')
    timers.advance(1100)
    expect(transport.types()).toEqual(['start']) // still inside the pause window
    recognizer.hear('Like this one.', '')
    timers.advance(1200)

    expect(recognizer.finalizeCalls).toBe(0) // everything was final already: no extra wait
    expect(transport.sent.at(-1)).toEqual({
      type: 'user_message',
      text: 'I have built three dashboards. Like this one.',
      source: 'speech',
    })
    expect(snap().phase).toBe('client_thinking')
    expect(recognizer.running).toBe(false)
    const entry = snap().transcript.at(-1)!
    expect(entry).toMatchObject({ speaker: 'you', kind: 'speech', pending: true })

    transport.emit({
      type: 'message_saved',
      message: { id: 'msg_9', role: 'user', kind: 'speech', content: entry.text, interrupted: false, material_id: null, created_at: '' },
    })
    expect(snap().transcript.at(-1)).toMatchObject({ id: 'msg_9', pending: false })
  })

  it('interrupting stops the voice and reports only what was heard', () => {
    startMeeting()
    say('Tell me about the budget.')
    reply('m2', 'The budget is eighteen thousand. That is fixed. We can talk.', { end: false })
    synth.progress(10)

    expect(meeting.interrupt()).toBe(true)
    expect(transport.sent.at(-1)).toEqual({ type: 'interrupt', message_id: 'm2', spoken_text: 'The budget' })
    expect(synth.cancels).toBe(1)
    expect(snap().phase).toBe('your_turn')
    expect(snap().caption).toBeNull()
    expect(snap().transcript.at(-1)).toMatchObject({ id: 'm2', text: 'The budget', interrupted: true, pending: false })
    expect(recognizer.running).toBe(true)

    // Text still streaming for the interrupted reply is ignored.
    transport.emit({ type: 'assistant_delta', message_id: 'm2', text: ' More words.' })
    expect(synth.current).toBeNull()
    expect(meeting.interrupt()).toBe(false)
  })

  it('a typed message while the client talks interrupts them first', () => {
    startMeeting()
    say('Hello there.')
    reply('m2', 'Great to meet you. So tell me.', { end: false })
    synth.finishOne()

    meeting.sendText('  Sorry, one question  ')
    expect(transport.sent.slice(-2)).toEqual([
      { type: 'interrupt', message_id: 'm2', spoken_text: 'Great to meet you.' },
      { type: 'user_message', text: 'Sorry, one question', source: 'typed' },
    ])
    expect(snap().caption).toBeNull() // typed text isn't a subtitle
  })

  it('ignores a reply that started before the server saw our newer turn', () => {
    startMeeting()
    say('First thought.')
    meeting.sendText('Actually, second thought.')

    transport.emit({ type: 'assistant_start', message_id: 'stale' }) // reply to the first thought
    transport.emit({ type: 'assistant_delta', message_id: 'stale', text: 'About your first. ' })
    expect(synth.current).toBeNull()

    ack('Actually, second thought.', 'typed')
    reply('fresh', 'Sure, go ahead.')
    expect(synth.current?.messageId).toBe('fresh')
  })

  it('holds a shared document until the client finishes speaking', () => {
    startMeeting()
    say('Can I send you something?')
    reply('m2', 'Of course. Go ahead.', { end: false })

    meeting.shareMaterial({ kind: 'partnership', title: 'Co-selling', content: '70/30 revenue share' })
    expect(snap().queuedShares).toEqual(['Co-selling'])
    expect(transport.types()).not.toContain('share_material')

    transport.emit({ type: 'assistant_end', message_id: 'm2', text: 'Of course. Go ahead.', error: null })
    synth.finishAll()
    expect(transport.sent.at(-1)).toEqual({
      type: 'share_material',
      material: { kind: 'partnership', title: 'Co-selling', content: '70/30 revenue share' },
    })
    expect(snap().queuedShares).toEqual([])
    expect(snap().phase).toBe('client_thinking')

    transport.emit({
      type: 'material_added',
      material: { id: 'mat_2', kind: 'partnership', title: 'Co-selling', content: '70/30 revenue share', shared_during_meeting: true, added_at: '' },
      message: { id: 'msg_m', role: 'user', kind: 'material', content: '...', interrupted: false, material_id: 'mat_2', created_at: '' },
    })
    expect(snap().materials.map((m) => m.id)).toEqual(['mat_2'])
    expect(snap().transcript.at(-1)).toMatchObject({ kind: 'material', text: 'Co-selling', detail: 'Partnership ideas' })
    reply('m3', 'Thanks for sending that.')
    expect(synth.current?.messageId).toBe('m3')
  })

  it('with headphones, speaking over the client interrupts them', () => {
    setup({ bargeIn: true })
    startMeeting()
    say('Hi.')
    reply('m2', 'Let me explain the whole scope in detail. First', { end: false })
    expect(recognizer.running).toBe(true) // keeps listening during the client's turn
    synth.progress(6)

    recognizer.hear('', 'um') // a single word doesn't interrupt
    expect(snap().phase).toBe('client_speaking')

    recognizer.hear('', 'um actually wait')
    expect(transport.sent.at(-1)).toEqual({ type: 'interrupt', message_id: 'm2', spoken_text: 'Let me' })
    expect(snap().phase).toBe('you_speaking')
    timers.advance(1200)
    recognizer.hear('Um, actually, wait.', '')
    expect(transport.sent.at(-1)).toEqual({ type: 'user_message', text: 'Um, actually, wait.', source: 'speech' })
  })

  it('waits for the final result when the pause ends on an interim guess', () => {
    startMeeting()
    recognizer.hear('', 'we could start in much')
    timers.advance(1200)

    // The pause is over, but the words are still a guess: ask for the final result first.
    expect(recognizer.finalizeCalls).toBe(1)
    expect(recognizer.running).toBe(true) // not stopped: that would discard the final result
    expect(transport.types()).toEqual(['start'])

    recognizer.hear('We could start in March.', '')
    expect(transport.sent.at(-1)).toEqual({ type: 'user_message', text: 'We could start in March.', source: 'speech' })
    expect(snap().transcript.at(-1)).toMatchObject({ speaker: 'you', text: 'We could start in March.' })
  })

  it('sends the interim guess if the final result never arrives', () => {
    startMeeting()
    recognizer.hear('', 'we could start in March')
    timers.advance(1200 + FINAL_RESULT_WAIT_MS - 1)
    expect(transport.types()).toEqual(['start'])

    timers.advance(1)
    expect(transport.sent.at(-1)).toEqual({ type: 'user_message', text: 'we could start in March', source: 'speech' })
  })

  it('keeps the turn open if the participant goes on talking while the final result is pending', () => {
    startMeeting()
    recognizer.hear('', 'we could start')
    timers.advance(1200)
    expect(recognizer.finalizeCalls).toBe(1)

    recognizer.hear('', 'we could start in March') // more words: the pause starts over
    timers.advance(FINAL_RESULT_WAIT_MS)
    expect(transport.types()).toEqual(['start'])

    recognizer.hear('We could start in March.', '')
    timers.advance(1200)
    expect(transport.sent.at(-1)).toEqual({ type: 'user_message', text: 'We could start in March.', source: 'speech' })
  })

  it('removes a reply that failed before saying anything', () => {
    startMeeting()
    say('Hello?')
    transport.emit({ type: 'assistant_start', message_id: 'm2' })
    transport.emit({ type: 'assistant_end', message_id: 'm2', text: '', error: 'Rate limited.' })
    expect(snap().notice).toMatchObject({ tone: 'error', text: 'Rate limited.' })
    expect(snap().transcript.some((e) => e.id === 'm2')).toBe(false)
    expect(snap().phase).toBe('your_turn')
  })

  it('recovers when a turn is rejected by the server', () => {
    startMeeting()
    meeting.sendText('hello')
    transport.emit({ type: 'error', code: 'bad_request', message: 'Invalid message.', retryable: false })
    expect(snap().phase).toBe('your_turn')
    say('Let me try again.')
    reply('m3', 'Next reply.')
    expect(synth.current?.messageId).toBe('m3')
  })

  it('finishes speaking what arrived when the connection drops mid-reply', () => {
    startMeeting()
    say('Go on.')
    reply('m2', 'First part. Second', { end: false })
    transport.state('reconnecting', 1006)
    expect(snap().connection).toBe('reconnecting')
    synth.finishAll()
    expect(synth.spoken.slice(-2)).toEqual(['First part.', 'Second'])
    expect(snap().phase).toBe('your_turn')
  })

  it('stops everything when the meeting is opened elsewhere', () => {
    startMeeting()
    transport.state('closed', 4409)
    expect(snap().connection).toBe('replaced')
    expect(recognizer.running).toBe(false)
    meeting.sendText('ignored')
    expect(transport.sent.at(-1)?.type).not.toBe('user_message')
  })

  it('reports a blocked microphone and turns the mic off', () => {
    startMeeting()
    recognizer.events.onError('not-allowed')
    expect(snap().micOn).toBe(false)
    expect(snap().micBlocked).toMatch(/blocked/)
    meeting.setMic(true)
    expect(snap().micOn).toBe(false)
  })

  it('muting mid-sentence sends what was said so far', () => {
    startMeeting()
    recognizer.hear('We could start in March', '')
    meeting.setMic(false)
    expect(recognizer.running).toBe(false)
    expect(transport.sent.at(-1)).toEqual({ type: 'user_message', text: 'We could start in March', source: 'speech' })
  })

  it('rejoining a meeting in progress restores the transcript without restarting it', () => {
    const existing = session({
      messages: [
        { id: 'e', role: 'user', kind: 'event', content: '[Alex joined the call.]', interrupted: false, material_id: null, created_at: '2026-01-01T00:00:00Z' },
        { id: 'a', role: 'assistant', kind: 'reply', content: 'Hi Alex, so the—', interrupted: true, material_id: null, created_at: '2026-01-01T00:00:01Z' },
        { id: 'u', role: 'user', kind: 'speech', content: 'Hi!', interrupted: false, material_id: null, created_at: '2026-01-01T00:00:02Z' },
      ],
    })
    setup({}, existing)
    transport.emit({ type: 'ready', session: existing })
    expect(transport.sent).toEqual([])
    expect(snap().transcript.map((e) => [e.speaker, e.text, e.interrupted])).toEqual([
      ['client', 'Hi Alex, so the', true],
      ['you', 'Hi!', false],
    ])
    expect(snap().phase).toBe('your_turn')
  })

  it('ending the meeting cuts the client off and closes everything', () => {
    startMeeting()
    say('Thanks.')
    reply('m2', 'Before you go, one thing.', { end: false })
    meeting.end()
    expect(transport.sent.at(-1)).toMatchObject({ type: 'interrupt', message_id: 'm2' })
    expect(transport.closed).toBe(true)
    expect(recognizer.running).toBe(false)
    expect(recognizer.disposed).toBe(true)
    expect(snap().phase).toBe('ended')
    expect(snap().endedAt).not.toBeNull()
  })
})

describe('MeetingController with a recognizer that detects the end of a turn (Deepgram)', () => {
  let turns: FakeTurnRecognizer

  function setupTurns(options: { bargeIn?: boolean } = {}) {
    turns = new FakeTurnRecognizer()
    setup(options, session({ speech_engine: 'deepgram' }), turns)
  }

  beforeEach(() => setupTurns())

  it('gets the recognizer ready on joining and keeps it tuned to the pause setting', () => {
    expect(turns.prepared).toBe(true)
    expect(turns.endOfTurnMs).toBe(1200)
    meeting.updateOptions({ endOfTurnMs: 2500 })
    expect(turns.endOfTurnMs).toBe(2500)
  })

  it('sends the turn when the recognizer says it is over, however long the pauses in it', () => {
    startMeeting()
    turns.update('I am')
    expect(snap().phase).toBe('you_speaking')
    // Everything but the still-settling last word shows as recognized.
    expect(snap().caption).toEqual({ speaker: 'you', text: 'I am', spokenChars: 2 })

    timers.advance(10_000) // thinking mid-sentence doesn't end the turn
    expect(transport.types()).toEqual(['start'])

    turns.update('I am Ross, and I build data pipelines')
    turns.endTurn('I am Ross, and I build data pipelines.')
    expect(transport.sent.at(-1)).toEqual({
      type: 'user_message',
      text: 'I am Ross, and I build data pipelines.',
      source: 'speech',
    })
    expect(snap().phase).toBe('client_thinking')
    expect(turns.running).toBe(false) // not listening over the client's answer
  })

  it('with headphones, a lone "mm-hm" over the client is ignored but a real interruption is not', () => {
    setupTurns({ bargeIn: true })
    startMeeting()
    turns.endTurn('Hi.')
    ack('Hi.')
    reply('m2', 'Let me explain the whole scope in detail. First', { end: false })
    synth.progress(6)

    turns.update('Mm-hmm.')
    turns.endTurn('Mm-hmm.')
    expect(snap().phase).toBe('client_speaking')
    expect(transport.types().filter((type) => type === 'user_message')).toHaveLength(1)

    turns.update('Sorry, quick')
    expect(transport.sent.at(-1)).toEqual({ type: 'interrupt', message_id: 'm2', spoken_text: 'Let me' })
    turns.endTurn('Sorry, quick question about the budget.')
    expect(transport.sent.at(-1)).toEqual({
      type: 'user_message',
      text: 'Sorry, quick question about the budget.',
      source: 'speech',
    })
  })

  it('muting mid-turn sends what was said, and ignores the rest of that turn', () => {
    startMeeting()
    turns.update('We could start in')
    meeting.setMic(false)
    expect(transport.sent.at(-1)).toEqual({ type: 'user_message', text: 'We could start in', source: 'speech' })
    turns.endTurn('We could start in March.')
    expect(transport.types().filter((type) => type === 'user_message')).toHaveLength(1)
  })

  it('a recognizer that stops working for good switches the meeting to typing', () => {
    startMeeting()
    turns.update('We could')
    turns.events.onError('unavailable', 'Deepgram rejected the API key. Check DEEPGRAM_API_KEY in backend/.env.')
    expect(snap().micBlocked).toBe('Deepgram rejected the API key. Check DEEPGRAM_API_KEY in backend/.env.')
    expect(snap().micOn).toBe(false)
    expect(transport.sent.at(-1)).toEqual({ type: 'user_message', text: 'We could', source: 'speech' }) // nothing lost

    turns.events.onError('service', 'Lost the connection for speech recognition. Reconnecting…')
    expect(snap().notice).toMatchObject({ tone: 'error', text: 'Lost the connection for speech recognition. Reconnecting…' })
  })
})
