import { getRecognitionConstructor, type SpeechRecognitionConstructor, type SpeechRecognitionLike } from './webSpeech'

/**
 * `service`: transient trouble with the recognition service (it keeps trying).
 * `unavailable`: recognition can't work in this meeting (for example, the service rejected its key).
 */
export type RecognizerError =
  | 'not-allowed'
  | 'audio-capture'
  | 'network'
  | 'language-not-supported'
  | 'service'
  | 'unavailable'

export interface RecognizerEvents {
  /** `finalText` is newly finalized speech in this event; `interimText` is the current guess for the rest. */
  onResult(finalText: string, interimText: string): void
  /**
   * The participant finished their turn, and `text` is all of it. Only recognizers that
   * detect the end of a turn themselves (`detectsTurnEnd`) call this.
   */
  onTurnEnd(text: string): void
  /** `detail`, when given, is a more specific message to show than the default for `error`. */
  onError(error: RecognizerError, detail?: string): void
  onListeningChange(listening: boolean): void
}

export interface Recognizer {
  readonly supported: boolean
  /**
   * The recognizer decides when the participant has finished a turn and reports it with
   * `onTurnEnd`; the app's own pause timer isn't used.
   */
  readonly detectsTurnEnd: boolean
  lang: string
  setEvents(events: RecognizerEvents): void
  /** Get ready to listen (open the microphone and connections) without listening yet. */
  prepare(): void
  /** Listen continuously until `stop()`, restarting after the browser's own timeouts. */
  start(): void
  /** Stop and discard anything not yet delivered. */
  stop(): void
  /**
   * Ask for the final result of the speech heard so far (it arrives through `onResult`).
   * Listening carries on afterwards.
   */
  finalize(): void
  /** The "pause that ends your turn" setting; recognizers that detect turn ends tune themselves with it. */
  setEndOfTurnMs(ms: number): void
  /** Release everything: the meeting is over. */
  dispose(): void
}

export const noopRecognizerEvents: RecognizerEvents = {
  onResult() {},
  onTurnEnd() {},
  onError() {},
  onListeningChange() {},
}
const noop = noopRecognizerEvents

/**
 * Wraps the browser's SpeechRecognition. Chrome ends a "continuous" session on its own
 * after silence or a network hiccup, so the wrapper restarts it (with backoff) for as
 * long as the caller wants to listen.
 */
export class BrowserRecognizer implements Recognizer {
  lang = 'en-US'
  readonly supported: boolean
  readonly detectsTurnEnd = false
  private readonly ctor: SpeechRecognitionConstructor | null
  private events: RecognizerEvents = noop
  private active: SpeechRecognitionLike | null = null
  private wanted = false
  private failures = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(ctor: SpeechRecognitionConstructor | null = getRecognitionConstructor()) {
    this.ctor = ctor
    this.supported = ctor !== null
  }

  setEvents(events: RecognizerEvents): void {
    this.events = events
  }

  prepare(): void {
    // Nothing to set up ahead of time.
  }

  start(): void {
    if (!this.ctor) return
    this.wanted = true
    this.launch()
  }

  setEndOfTurnMs(): void {
    // The app's pause timer ends turns; nothing to tune here.
  }

  dispose(): void {
    this.stop()
  }

  stop(): void {
    this.wanted = false
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const rec = this.active
    if (!rec) return
    this.active = null
    rec.onresult = null
    try {
      rec.abort()
    } catch {
      // already stopped
    }
    this.events.onListeningChange(false)
  }

  finalize(): void {
    // stop(), unlike abort(), makes the service return a final result for the audio it already
    // has. `onend` follows, and the session restarts because we still want to listen.
    try {
      this.active?.stop()
    } catch {
      // not started yet
    }
  }

  private launch(): void {
    if (!this.ctor || !this.wanted || this.active) return
    const rec = new this.ctor()
    rec.lang = this.lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1

    rec.onstart = () => {
      if (this.active === rec) this.events.onListeningChange(true)
    }
    rec.onresult = (event) => {
      if (this.active !== rec) return
      this.failures = 0
      let finalText = ''
      let interimText = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        const transcript = result[0]?.transcript ?? ''
        if (result.isFinal) finalText += transcript
        else interimText += transcript
      }
      this.events.onResult(finalText.trim(), interimText.trim())
    }
    rec.onerror = (event) => {
      if (this.active !== rec) return
      switch (event.error) {
        case 'no-speech':
        case 'aborted':
          return // routine: onend follows and we restart
        case 'not-allowed':
        case 'service-not-allowed':
          this.wanted = false
          this.events.onError('not-allowed')
          return
        case 'audio-capture':
          this.wanted = false
          this.events.onError('audio-capture')
          return
        case 'language-not-supported':
          this.wanted = false
          this.events.onError('language-not-supported')
          return
        case 'network':
          this.failures++
          if (this.failures === 3) this.events.onError('network') // once per streak; retries continue
          return
        default:
          this.failures++
      }
    }
    rec.onend = () => {
      if (this.active !== rec) return
      this.active = null
      this.events.onListeningChange(false)
      if (this.wanted) this.scheduleRestart()
    }

    this.active = rec
    try {
      rec.start()
    } catch {
      this.active = null
      this.failures++
      this.scheduleRestart()
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const delay = Math.min(150 * 2 ** this.failures, 5000)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.launch()
    }, delay)
  }
}
