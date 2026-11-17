import { MicrophoneUnavailable, microphoneSupported, openMicrophone, type Microphone, type SamplesListener } from './microphone'
import { PcmEncoder } from './pcm'
import { noopRecognizerEvents, type Recognizer, type RecognizerEvents } from './recognizer'

/**
 * Speech recognition by Deepgram Flux, relayed by the server (backend/app/speech.py).
 *
 * The microphone streams continuously as 16 kHz PCM. While the app isn't listening (the client
 * is talking, or the mic is muted) silence goes out in its place, so the stream stays open and
 * nobody but the participant is transcribed. Flux decides when the participant has finished a
 * turn, which is why this recognizer reports `onTurnEnd` and the app's pause timer isn't used.
 */

/** The parts of a WebSocket this uses. */
export interface SpeechSocketLike {
  readonly readyState: number
  binaryType: BinaryType
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string | ArrayBufferView<ArrayBuffer>): void
  close(code?: number): void
}

export interface StreamingTimers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface StreamingRecognizerDeps {
  /** The speech socket's address (the turn settings are added as its query string). */
  url: string
  openSocket?: (url: string) => SpeechSocketLike
  openMicrophone?: (onSamples: SamplesListener) => Promise<Microphone>
  timers?: StreamingTimers
}

export interface FluxTurnSettings {
  eot_threshold: number
  eot_timeout_ms: number
}

/**
 * Maps the "pause that ends your turn" setting (600–3,000 ms) onto Flux's end-of-turn controls.
 * A longer pause setting makes Flux surer the participant has finished before ending the turn
 * (eot_threshold 0.70–0.90; Deepgram's default is 0.7) and lets them stay silent longer
 * mid-thought (eot_timeout_ms 3–10 s). The default of 1.2 s gives 0.75 and 4.75 s.
 */
export function fluxTurnSettings(endOfTurnMs: number): FluxTurnSettings {
  const t = Math.min(1, Math.max(0, (endOfTurnMs - 600) / 2_400))
  return { eot_threshold: Math.round((0.7 + 0.2 * t) * 100) / 100, eot_timeout_ms: Math.round(3_000 + 7_000 * t) }
}

const OPEN = 1
/** Close codes after which reconnecting is pointless (see backend/app/speech.py). */
const FATAL_CLOSE_CODES = new Set([4400, 4403, 4404, 4409, 4410])
const SILENT_CLOSE_CODES = new Set([4409, 4410]) // replaced or ended: the meeting socket reports these
/** About 3 s of audio, kept while the socket (re)connects so the start of a sentence isn't lost. */
const MAX_PENDING_CHUNKS = 40
const FAILURES_BEFORE_REPORTING = 2

interface ServerMessage {
  type?: string
  event?: string
  turn_index?: number
  transcript?: string
  message?: string
  retryable?: boolean
}

const defaultTimers: StreamingTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class StreamingRecognizer implements Recognizer {
  readonly supported: boolean
  readonly detectsTurnEnd = true
  /** Unused: the language comes with the Flux model on the server. */
  lang = 'en-US'

  private readonly deps: StreamingRecognizerDeps
  private readonly timers: StreamingTimers
  private events: RecognizerEvents = noopRecognizerEvents
  private endOfTurnMs = 1_200
  private prepared = false
  private disposed = false
  /** A fatal error: recognition is off for the rest of the meeting. */
  private failed = false
  private listening = false
  private announcedListening = false

  private microphone: Microphone | null = null
  private encoder: PcmEncoder | null = null
  private socket: SpeechSocketLike | null = null
  /** The server reported that Deepgram accepted the stream. */
  private ready = false
  private pending: Int16Array<ArrayBuffer>[] = []
  private failures = 0
  private retryTimer: unknown = null
  private lastError: { message: string; retryable: boolean } | null = null

  // Turns on the current stream (Flux numbers them from 0 for each new stream).
  private latestTurn = -1
  private endedTurn = -1
  /** Turns before this one were spoken while we weren't listening, or were cut off. */
  private acceptFrom = 0
  /** The transcript so far of the turn being delivered. */
  private turnText = ''

  constructor(deps: StreamingRecognizerDeps) {
    this.deps = deps
    this.timers = deps.timers ?? defaultTimers
    this.supported = deps.openMicrophone !== undefined || microphoneSupported()
  }

  setEvents(events: RecognizerEvents): void {
    this.events = events
  }

  prepare(): void {
    if (this.prepared || this.disposed || !this.supported) return
    this.prepared = true
    this.connect()
    void this.openMicrophone()
  }

  start(): void {
    if (this.disposed || this.failed || !this.supported) return
    this.prepare()
    if (this.listening) return
    this.listening = true
    this.skipTurnInProgress() // anything Flux is in the middle of was said before we listened
    this.sendControl({ type: 'listening', on: true })
    this.updateListening()
  }

  stop(): void {
    if (!this.listening) return
    this.listening = false
    this.skipTurnInProgress()
    this.sendControl({ type: 'listening', on: false })
    this.updateListening()
  }

  finalize(): void {
    // Flux finalizes each turn itself.
  }

  setEndOfTurnMs(ms: number): void {
    this.endOfTurnMs = ms
    this.sendControl({ type: 'configure', ...fluxTurnSettings(ms) })
  }

  dispose(): void {
    if (this.disposed) return
    this.stop()
    this.disposed = true
    this.closeEverything()
  }

  // ------------------------------------------------------------------ audio

  private async openMicrophone(): Promise<void> {
    const open = this.deps.openMicrophone ?? openMicrophone
    try {
      const microphone = await open((samples, sampleRate) => this.handleSamples(samples, sampleRate))
      if (this.disposed || this.failed) {
        microphone.stop()
        return
      }
      this.microphone = microphone
      this.updateListening()
    } catch (error) {
      if (this.disposed) return
      if (error instanceof MicrophoneUnavailable) this.fail(error.reason)
      else this.fail('unavailable', 'Couldn’t start the microphone for speech recognition. You can type your replies.')
    }
  }

  private handleSamples(samples: Float32Array, sampleRate: number): void {
    if (this.disposed || this.failed) return
    this.encoder ??= new PcmEncoder(sampleRate)
    for (const chunk of this.encoder.push(samples)) this.sendAudio(this.listening ? chunk : new Int16Array(chunk.length))
  }

  private sendAudio(chunk: Int16Array<ArrayBuffer>): void {
    const socket = this.socket
    if (socket && socket.readyState === OPEN) {
      socket.send(chunk)
      return
    }
    if (!this.listening) return // silence isn't worth keeping
    this.pending.push(chunk)
    if (this.pending.length > MAX_PENDING_CHUNKS) this.pending.shift()
  }

  // ------------------------------------------------------------------ the speech socket

  private connect(): void {
    if (this.disposed || this.failed) return
    const settings = fluxTurnSettings(this.endOfTurnMs)
    const url = `${this.deps.url}?eot_threshold=${settings.eot_threshold}&eot_timeout_ms=${settings.eot_timeout_ms}`
    const socket = (this.deps.openSocket ?? ((address: string) => new WebSocket(address)))(url)
    socket.binaryType = 'arraybuffer'
    this.socket = socket
    this.ready = false
    this.latestTurn = -1
    this.endedTurn = -1
    this.acceptFrom = 0
    this.turnText = ''

    socket.onopen = () => {
      if (this.socket !== socket) return
      // Where we are first, then whatever was said while connecting.
      socket.send(JSON.stringify({ type: 'listening', on: this.listening }))
      for (const chunk of this.pending) socket.send(chunk)
      this.pending = []
    }
    socket.onmessage = (event) => {
      if (this.socket === socket && typeof event.data === 'string') this.handleMessage(event.data)
    }
    socket.onclose = (event) => {
      if (this.socket === socket) this.handleClose(event.code)
    }
  }

  private handleMessage(raw: string): void {
    let message: ServerMessage
    try {
      message = JSON.parse(raw) as ServerMessage
    } catch {
      return
    }
    if (message.type === 'ready') {
      this.ready = true
      this.failures = 0
      this.updateListening()
    } else if (message.type === 'turn') {
      this.handleTurn(String(message.event ?? ''), Number(message.turn_index ?? 0), String(message.transcript ?? '').trim())
    } else if (message.type === 'error') {
      this.lastError = { message: message.message ?? '', retryable: message.retryable !== false }
    }
  }

  private handleTurn(event: string, index: number, transcript: string): void {
    // Flux reports silence too (empty Updates for the coming turn); only speech starts a turn.
    if (!transcript && event !== 'EndOfTurn') return
    this.latestTurn = Math.max(this.latestTurn, index)
    if (event === 'EndOfTurn') this.endedTurn = Math.max(this.endedTurn, index)
    if (!this.listening || index < this.acceptFrom) return
    if (event === 'EndOfTurn') {
      this.acceptFrom = index + 1
      this.turnText = ''
      if (transcript) this.events.onTurnEnd(transcript)
      return
    }
    this.turnText = transcript
    if (transcript) this.events.onResult('', transcript)
  }

  private handleClose(code: number): void {
    this.socket = null
    this.ready = false
    const error = this.lastError
    this.lastError = null
    // A turn the dropped connection cut off: deliver what was said instead of leaving it hanging.
    if (this.listening && this.turnText) {
      const text = this.turnText
      this.turnText = ''
      this.events.onTurnEnd(text)
    }
    this.updateListening()
    if (this.disposed || this.failed) return

    if (FATAL_CLOSE_CODES.has(code) || (error !== null && !error.retryable)) {
      if (SILENT_CLOSE_CODES.has(code)) {
        this.failed = true
        this.closeEverything()
      } else {
        this.fail('unavailable', error?.message || 'Speech recognition isn’t available. You can type your replies.')
      }
      return
    }
    this.failures++
    if (this.failures === FAILURES_BEFORE_REPORTING) {
      this.events.onError('service', error?.message || 'Lost the connection for speech recognition. Reconnecting…')
    }
    const delay = Math.min(500 * 2 ** (this.failures - 1), 8_000)
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  // ------------------------------------------------------------------ helpers

  /** Skip the turn Flux is in the middle of, if any, and have it closed. */
  private skipTurnInProgress(): void {
    this.acceptFrom = this.latestTurn + 1
    this.turnText = ''
    if (this.latestTurn > this.endedTurn) this.sendControl({ type: 'end_turn' })
  }

  private sendControl(message: object): void {
    const socket = this.socket
    if (socket && socket.readyState === OPEN) socket.send(JSON.stringify(message))
  }

  private updateListening(): void {
    const listening = this.listening && this.ready && this.microphone !== null
    if (listening === this.announcedListening) return
    this.announcedListening = listening
    this.events.onListeningChange(listening)
  }

  private fail(error: 'not-allowed' | 'audio-capture' | 'unavailable', detail?: string): void {
    this.failed = true
    this.listening = false
    this.closeEverything()
    this.updateListening()
    this.events.onError(error, detail)
  }

  private closeEverything(): void {
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.microphone?.stop()
    this.microphone = null
    this.pending = []
    const socket = this.socket
    this.socket = null
    this.ready = false
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = null
      try {
        socket.close(1000)
      } catch {
        // already closed
      }
    }
  }
}
