import { beforeEach, describe, expect, it } from 'vitest'
import { MicrophoneUnavailable, type SamplesListener } from './microphone'
import type { RecognizerEvents } from './recognizer'
import {
  StreamingRecognizer,
  fluxTurnSettings,
  type SpeechSocketLike,
  type StreamingTimers,
} from './streamingRecognizer'

// ------------------------------------------------------------------ fakes

class FakeSocket implements SpeechSocketLike {
  readyState = 0
  binaryType: BinaryType = 'blob'
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  sent: (string | ArrayBufferView<ArrayBuffer>)[] = []
  closedWith: number | null = null
  readonly url: string

  constructor(url: string) {
    this.url = url
  }
  send(data: string | ArrayBufferView<ArrayBuffer>) {
    this.sent.push(data)
  }
  close(code?: number) {
    this.closedWith = code ?? 1000
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.({} as Event)
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
  }
  turn(event: string, turn_index: number, transcript: string) {
    this.receive({ type: 'turn', event, turn_index, transcript })
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code } as CloseEvent)
  }
  controls(): unknown[] {
    return this.sent.filter((data): data is string => typeof data === 'string').map((data) => JSON.parse(data))
  }
  audio(): Int16Array[] {
    return this.sent.filter((data) => typeof data !== 'string') as Int16Array[]
  }
}

class ManualTimers implements StreamingTimers {
  private seq = 0
  tasks = new Map<number, () => void>()
  setTimeout(callback: () => void) {
    const id = ++this.seq
    this.tasks.set(id, callback)
    return id
  }
  clearTimeout(id: unknown) {
    this.tasks.delete(id as number)
  }
  runAll() {
    const due = [...this.tasks.values()]
    this.tasks.clear()
    due.forEach((task) => task())
  }
}

// ------------------------------------------------------------------ fixtures

let sockets: FakeSocket[]
let mic: { listener: SamplesListener | null; stopped: boolean }
let timers: ManualTimers
let log: unknown[][]
let recognizer: StreamingRecognizer

const socket = () => sockets.at(-1)!
const results = () => log.filter(([kind]) => kind === 'result' || kind === 'turnEnd')
const errors = () => log.filter(([kind]) => kind === 'error')

async function setup({ micError }: { micError?: Error } = {}) {
  sockets = []
  mic = { listener: null, stopped: false }
  timers = new ManualTimers()
  log = []
  recognizer = new StreamingRecognizer({
    url: 'ws://test/api/sessions/ses_1/speech',
    openSocket: (url) => {
      const created = new FakeSocket(url)
      sockets.push(created)
      return created
    },
    openMicrophone: async (listener) => {
      if (micError) throw micError
      mic.listener = listener
      return { stop: () => (mic.stopped = true) }
    },
    timers,
  })
  const events: RecognizerEvents = {
    onResult: (finalText, interimText) => log.push(['result', finalText, interimText]),
    onTurnEnd: (text) => log.push(['turnEnd', text]),
    onError: (error, detail) => log.push(['error', error, detail]),
    onListeningChange: (listening) => log.push(['listening', listening]),
  }
  recognizer.setEvents(events)
  recognizer.setEndOfTurnMs(1200)
  recognizer.prepare()
  await new Promise((resolve) => setTimeout(resolve, 0)) // the microphone opens
}

async function connected() {
  await setup()
  socket().open()
  socket().receive({ type: 'ready' })
}

/** One 80 ms chunk of 16 kHz microphone audio. */
function talk(level = 0.25) {
  mic.listener!(new Float32Array(1280).fill(level), 16_000)
}

const silent = (chunk: Int16Array) => chunk.every((sample) => sample === 0)

// ------------------------------------------------------------------ tests

describe('StreamingRecognizer', () => {
  beforeEach(() => setup())

  it('opens the speech socket with the turn settings and streams silence until it listens', async () => {
    await connected()
    expect(socket().url).toBe('ws://test/api/sessions/ses_1/speech?eot_threshold=0.75&eot_timeout_ms=4750')
    expect(socket().controls()).toEqual([{ type: 'listening', on: false }])

    talk()
    expect(socket().audio()).toHaveLength(1)
    expect(silent(socket().audio()[0])).toBe(true) // not listening: the microphone isn't sent

    recognizer.start()
    expect(log).toContainEqual(['listening', true])
    expect(socket().controls().at(-1)).toEqual({ type: 'listening', on: true })
    talk()
    const chunk = socket().audio()[1]
    expect(chunk).toHaveLength(1280)
    expect(chunk[0]).toBe(8192) // a quarter of full scale

    recognizer.stop()
    talk()
    expect(silent(socket().audio()[2])).toBe(true)
    expect(log.at(-1)).toEqual(['listening', false])
  })

  it('keeps what is said while it connects and sends it once connected', async () => {
    recognizer.start()
    talk()
    talk()
    expect(socket().sent).toEqual([])
    socket().open()
    expect(socket().controls()).toEqual([{ type: 'listening', on: true }])
    expect(socket().audio()).toHaveLength(2)
    expect(log).not.toContainEqual(['listening', true]) // not until the service is ready
    socket().receive({ type: 'ready' })
    expect(log).toContainEqual(['listening', true])
  })

  it('reports the turn as it grows, and when it ends', async () => {
    await connected()
    recognizer.start()
    socket().turn('StartOfTurn', 0, 'I am')
    socket().turn('Update', 0, 'I am Ross')
    socket().turn('EndOfTurn', 0, 'I am Ross.')
    socket().turn('StartOfTurn', 1, 'And')
    expect(results()).toEqual([
      ['result', '', 'I am'],
      ['result', '', 'I am Ross'],
      ['turnEnd', 'I am Ross.'],
      ['result', '', 'And'],
    ])
  })

  it('treats the empty updates Flux sends during silence as no turn at all', async () => {
    await connected()
    socket().turn('Update', 0, '') // Flux reports silence for the coming turn every ~0.25 s
    socket().turn('Update', 0, '')
    recognizer.start()
    expect(socket().controls()).not.toContainEqual({ type: 'end_turn' })

    socket().turn('StartOfTurn', 0, 'Hello')
    socket().turn('EndOfTurn', 0, 'Hello, I am Ross.')
    socket().turn('Update', 1, '')
    recognizer.stop()
    recognizer.start()
    socket().turn('StartOfTurn', 1, 'Next')
    expect(results()).toEqual([
      ['result', '', 'Hello'],
      ['turnEnd', 'Hello, I am Ross.'],
      ['result', '', 'Next'],
    ])
    expect(socket().controls()).not.toContainEqual({ type: 'end_turn' })
  })

  it('ignores a turn that began while it was not listening, and has it closed', async () => {
    await connected()
    socket().turn('StartOfTurn', 0, 'heard before listening')
    expect(results()).toEqual([])

    recognizer.start()
    expect(socket().controls()).toContainEqual({ type: 'end_turn' })
    socket().turn('EndOfTurn', 0, 'heard before listening')
    socket().turn('StartOfTurn', 1, 'Hello')
    expect(results()).toEqual([['result', '', 'Hello']])
  })

  it('stopping mid-turn closes that turn and drops the rest of it', async () => {
    await connected()
    recognizer.start()
    socket().turn('StartOfTurn', 0, 'We could')
    recognizer.stop()
    expect(socket().controls()).toContainEqual({ type: 'end_turn' })

    recognizer.start()
    socket().turn('Update', 0, 'We could start')
    socket().turn('EndOfTurn', 0, 'We could start.')
    socket().turn('StartOfTurn', 1, 'March')
    expect(results()).toEqual([
      ['result', '', 'We could'],
      ['result', '', 'March'],
    ])
  })

  it('a dropped connection delivers the turn in progress, then reconnects', async () => {
    await connected()
    recognizer.start()
    socket().turn('Update', 0, 'We could start in March')
    socket().drop()
    expect(results().at(-1)).toEqual(['turnEnd', 'We could start in March'])
    expect(sockets).toHaveLength(1)

    timers.runAll()
    expect(sockets).toHaveLength(2)
    socket().open()
    expect(socket().controls()).toEqual([{ type: 'listening', on: true }])
    socket().receive({ type: 'ready' })
    socket().turn('EndOfTurn', 0, 'Next question.') // a new stream numbers its turns from 0
    expect(results().at(-1)).toEqual(['turnEnd', 'Next question.'])
  })

  it('reports a connection that keeps failing once, and keeps trying', async () => {
    socket().drop()
    timers.runAll()
    expect(errors()).toEqual([])
    socket().drop()
    expect(errors()).toEqual([['error', 'service', 'Lost the connection for speech recognition. Reconnecting…']])
    timers.runAll()
    socket().drop()
    expect(errors()).toHaveLength(1)
    expect(timers.tasks.size).toBe(1)
  })

  it('turns itself off for the meeting when the service rejects it', async () => {
    socket().open()
    socket().receive({
      type: 'error',
      code: 'auth',
      message: 'Deepgram rejected the API key. Check DEEPGRAM_API_KEY in backend/.env.',
      retryable: false,
    })
    socket().drop(4400)
    expect(errors()).toEqual([['error', 'unavailable', 'Deepgram rejected the API key. Check DEEPGRAM_API_KEY in backend/.env.']])
    expect(mic.stopped).toBe(true)
    timers.runAll()
    expect(sockets).toHaveLength(1) // no retry

    recognizer.start()
    expect(log).not.toContainEqual(['listening', true])
  })

  it('goes quiet when the meeting is opened in another window', async () => {
    socket().open()
    socket().drop(4409)
    expect(errors()).toEqual([]) // the meeting itself reports that
    expect(mic.stopped).toBe(true)
    timers.runAll()
    expect(sockets).toHaveLength(1)
  })

  it('reports a blocked microphone', async () => {
    await setup({ micError: new MicrophoneUnavailable('not-allowed') })
    expect(errors()).toEqual([['error', 'not-allowed', undefined]])
    expect(socket().closedWith).toBe(1000) // no point streaming
  })

  it('passes the pause setting on as Flux turn settings', async () => {
    await connected()
    recognizer.setEndOfTurnMs(3000)
    expect(socket().controls().at(-1)).toEqual({ type: 'configure', eot_threshold: 0.9, eot_timeout_ms: 10_000 })
    expect(fluxTurnSettings(600)).toEqual({ eot_threshold: 0.7, eot_timeout_ms: 3_000 })
    expect(fluxTurnSettings(1200)).toEqual({ eot_threshold: 0.75, eot_timeout_ms: 4_750 })
    expect(fluxTurnSettings(10_000)).toEqual({ eot_threshold: 0.9, eot_timeout_ms: 10_000 })
  })

  it('disposing closes the socket and the microphone for good', async () => {
    await connected()
    recognizer.start()
    recognizer.dispose()
    expect(socket().closedWith).toBe(1000)
    expect(mic.stopped).toBe(true)
    expect(timers.tasks.size).toBe(0)
  })
})
