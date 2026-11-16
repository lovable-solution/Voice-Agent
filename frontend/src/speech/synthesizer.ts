import { SpeechPaceEstimator, wordEnd } from '../lib/captionTiming'
import { rankVoices } from './voices'
import { speechSynthesisAvailable } from './webSpeech'

export interface SpeakItem {
  id: string
  messageId: string
  text: string
}

export interface SynthesizerEvents {
  onStart(item: SpeakItem): void
  /** `spokenChars` characters of `item.text` have been spoken (snapped to word ends). */
  onProgress(item: SpeakItem, spokenChars: number): void
  /** The item finished. Not called for items dropped by `cancel()`. */
  onEnd(item: SpeakItem): void
  /** Playback keeps failing; the synthesizer switched to captions-only timing. */
  onFailure(message: string): void
}

export interface VoiceSettings {
  voiceURI: string | null
  rate: number
  /** Captions only: no audio, captions advance at an estimated speaking pace. */
  muted: boolean
  lang: string
}

export interface Synthesizer {
  readonly supported: boolean
  setEvents(events: SynthesizerEvents): void
  configure(settings: Partial<VoiceSettings>): void
  /** Queue an item; items are spoken one after another. */
  speak(item: SpeakItem): void
  /** Stop now and drop everything queued. */
  cancel(): void
}

interface Playback {
  cancel(): void
}

interface PlaybackCallbacks {
  started(): void
  boundary(charIndex: number): void
  ended(): void
  failed(): void
}

interface Active {
  item: SpeakItem
  playback: Playback | null
  startedAt: number
  lastChars: number
  boundarySeen: boolean
  silent: boolean
  done: boolean
  timers: ReturnType<typeof setTimeout>[]
  ticker: ReturnType<typeof setInterval> | null
}

const noop: SynthesizerEvents = { onStart() {}, onProgress() {}, onEnd() {}, onFailure() {} }
const START_TIMEOUT_MS = 3000
const PROGRESS_TICK_MS = 90

/**
 * Speaks queued sentences with the Web Speech API and reports progress for live captions.
 *
 * Word-boundary events drive the captions when the voice provides them; otherwise (and in
 * captions-only mode) progress is estimated from a pace that calibrates itself on every
 * finished sentence. Watchdogs cover two Chrome bugs: utterances that never start, and
 * `end` events that never arrive.
 */
export class SpeechSynthesizer implements Synthesizer {
  readonly supported: boolean
  private events: SynthesizerEvents = noop
  private settings: VoiceSettings = { voiceURI: null, rate: 1, muted: false, lang: 'en-US' }
  private readonly estimator = new SpeechPaceEstimator()
  private queue: SpeakItem[] = []
  private active: Active | null = null
  private consecutiveFailures = 0
  private audioBroken = false
  private lastCancelAt = 0
  private readonly synth: SpeechSynthesis | null

  constructor(synth: SpeechSynthesis | null = speechSynthesisAvailable() ? window.speechSynthesis : null) {
    this.synth = synth
    this.supported = synth !== null
    // A previous page may have left speech running or paused.
    synth?.cancel()
  }

  setEvents(events: SynthesizerEvents): void {
    this.events = events
  }

  configure(settings: Partial<VoiceSettings>): void {
    this.settings = { ...this.settings, ...settings }
  }

  speak(item: SpeakItem): void {
    this.queue.push(item)
    if (!this.active) this.next()
  }

  cancel(): void {
    this.queue = []
    const active = this.active
    this.active = null
    if (!active) return
    active.done = true
    this.clearTimers(active)
    active.playback?.cancel()
    this.lastCancelAt = Date.now()
  }

  private get silent(): boolean {
    return this.settings.muted || this.audioBroken || !this.synth
  }

  private next(): void {
    const item = this.queue.shift()
    if (!item) return
    const active: Active = {
      item,
      playback: null,
      startedAt: 0,
      lastChars: 0,
      boundarySeen: false,
      silent: this.silent,
      done: false,
      timers: [],
      ticker: null,
    }
    this.active = active
    if (active.silent) {
      this.playSilently(active)
      return
    }
    active.playback = this.playAloud(item, {
      started: () => this.handleStart(active),
      boundary: (charIndex) => this.handleBoundary(active, charIndex),
      ended: () => this.finish(active, true),
      failed: () => this.handleFailure(active),
    })
    active.timers.push(
      setTimeout(() => {
        if (!active.startedAt && !active.done) this.handleFailure(active)
      }, START_TIMEOUT_MS),
    )
  }

  private handleStart(active: Active): void {
    if (active.done || active.startedAt) return
    active.startedAt = Date.now()
    this.events.onStart(active.item)
    active.ticker = setInterval(() => this.tick(active), PROGRESS_TICK_MS)
    const expected = this.estimator.durationMs(active.item.text, this.settings.rate)
    // Chrome sometimes never fires `end`; don't let that stall the conversation.
    active.timers.push(setTimeout(() => this.finish(active, false), expected * 2.5 + 3000))
  }

  private handleBoundary(active: Active, charIndex: number): void {
    if (active.done) return
    active.boundarySeen = true
    this.report(active, wordEnd(active.item.text, charIndex + 1))
  }

  private tick(active: Active): void {
    if (active.done || active.boundarySeen || !active.startedAt) return
    const elapsed = Date.now() - active.startedAt
    this.report(active, this.estimator.charsAt(active.item.text, elapsed, active.silent ? 1 : this.settings.rate))
  }

  private report(active: Active, chars: number): void {
    if (chars <= active.lastChars) return
    active.lastChars = chars
    this.events.onProgress(active.item, chars)
  }

  private handleFailure(active: Active): void {
    if (active.done) return
    active.playback?.cancel()
    active.playback = null
    this.consecutiveFailures++
    if (this.consecutiveFailures >= 2 && !this.audioBroken) {
      this.audioBroken = true
      this.events.onFailure("The browser couldn't play the client's voice, so captions continue on their own.")
    }
    // Finish this sentence as captions only, from wherever it got to.
    this.clearTimers(active)
    active.silent = true
    if (!active.startedAt) {
      this.playSilently(active)
      return
    }
    const remaining = this.estimator.durationMs(active.item.text) - (Date.now() - active.startedAt)
    active.ticker = setInterval(() => this.tick(active), PROGRESS_TICK_MS)
    active.timers.push(setTimeout(() => this.finish(active, false), Math.max(300, remaining)))
  }

  private playSilently(active: Active): void {
    active.timers.push(
      setTimeout(() => {
        this.handleStart(active)
        active.timers.push(
          setTimeout(() => this.finish(active, false), this.estimator.durationMs(active.item.text)),
        )
      }, 0),
    )
  }

  private finish(active: Active, playedToEnd: boolean): void {
    if (active.done || this.active !== active) return
    active.done = true
    this.clearTimers(active)
    if (playedToEnd) {
      this.consecutiveFailures = 0
      if (active.startedAt) {
        this.estimator.record(active.item.text, Date.now() - active.startedAt, this.settings.rate)
      }
    }
    this.report(active, active.item.text.length)
    this.active = null
    this.events.onEnd(active.item)
    if (this.active === null) this.next()
  }

  private clearTimers(active: Active): void {
    for (const timer of active.timers) clearTimeout(timer)
    active.timers = []
    if (active.ticker) clearInterval(active.ticker)
    active.ticker = null
  }

  private resolveVoice(): SpeechSynthesisVoice | null {
    const voices = this.synth?.getVoices() ?? []
    if (this.settings.voiceURI) {
      const chosen = voices.find((v) => v.voiceURI === this.settings.voiceURI)
      if (chosen) return chosen
    }
    return rankVoices(voices, this.settings.lang)[0] ?? null
  }

  private playAloud(item: SpeakItem, callbacks: PlaybackCallbacks): Playback {
    const synth = this.synth!
    const utterance = new SpeechSynthesisUtterance(item.text)
    const voice = this.resolveVoice()
    if (voice) utterance.voice = voice
    utterance.lang = voice?.lang ?? this.settings.lang
    utterance.rate = this.settings.rate
    utterance.onstart = () => callbacks.started()
    utterance.onboundary = (event) => {
      if (!event.name || event.name === 'word') callbacks.boundary(event.charIndex)
    }
    utterance.onend = () => callbacks.ended()
    utterance.onerror = (event) => {
      if (event.error === 'interrupted' || event.error === 'canceled') return
      callbacks.failed()
    }

    let cancelled = false
    const speakNow = () => {
      if (cancelled) return
      if (synth.paused) synth.resume()
      synth.speak(utterance)
    }
    // Chrome drops an utterance spoken immediately after cancel().
    const sinceCancel = Date.now() - this.lastCancelAt
    if (sinceCancel < 150) setTimeout(speakNow, 150 - sinceCancel)
    else speakNow()

    // `utterance` stays referenced from this closure until cancel or the next item,
    // which keeps Chrome from garbage-collecting it before its `end` event.
    return {
      cancel: () => {
        cancelled = true
        utterance.onstart = utterance.onend = utterance.onerror = utterance.onboundary = null
        synth.cancel()
      },
    }
  }
}
