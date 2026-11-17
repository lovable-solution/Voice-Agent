import { SentenceChunker } from '../lib/sentences'
import { joinSpoken, sanitizeForSpeech } from '../lib/speechText'
import type { Recognizer, RecognizerError } from '../speech/recognizer'
import type { SpeakItem, Synthesizer, VoiceSettings } from '../speech/synthesizer'
import {
  KIND_LABELS,
  MAX_UTTERANCE_CHARS,
  type ChatMessage,
  type ClientEvent,
  type Material,
  type MaterialIn,
  type ServerEvent,
  type SessionOut,
} from '../types'
import { CLOSE_CODES, type ConnectionState, type MeetingTransport } from './transport'

/**
 * Turn-taking for the meeting:
 *
 *   client_thinking -> client_speaking -> your_turn -> you_speaking -> client_thinking ...
 *
 * The client's reply streams in over the socket, is cut into sentences, and spoken one
 * sentence at a time while captions follow the voice. When the voice finishes, the mic
 * listens; after `endOfTurnMs` of silence the participant's words are sent as their turn.
 * Interrupting stops the voice and tells the server how much of the reply was heard.
 */

export type Phase = 'connecting' | 'client_thinking' | 'client_speaking' | 'your_turn' | 'you_speaking' | 'ended'
export type Speaker = 'client' | 'you'
export type ConnectionStatus = ConnectionState | 'replaced' | 'gone'

export interface TranscriptEntry {
  id: string
  speaker: Speaker
  kind: 'speech' | 'typed' | 'reply' | 'material'
  text: string
  /** For shared material: its kind, e.g. "Partnership ideas". */
  detail?: string
  interrupted: boolean
  pending: boolean
  at: number
}

export interface Caption {
  speaker: Speaker
  text: string
  /** How much of `text` has been spoken (client) or finalized (you). */
  spokenChars: number
}

export interface Notice {
  id: number
  tone: 'error' | 'info'
  text: string
}

export interface MeetingOptions {
  /** Silence that ends the participant's turn. */
  endOfTurnMs: number
  /** Keep listening while the client talks, so speaking interrupts them (needs headphones). */
  bargeIn: boolean
}

export interface MeetingSnapshot {
  phase: Phase
  connection: ConnectionStatus
  transcript: TranscriptEntry[]
  caption: Caption | null
  micOn: boolean
  micSupported: boolean
  micBlocked: string | null
  listening: boolean
  notice: Notice | null
  queuedShares: string[]
  materials: Material[]
  startedAt: number | null
  endedAt: number | null
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface ControllerDeps {
  session: SessionOut
  transport: MeetingTransport
  synthesizer: Synthesizer
  recognizer: Recognizer
  options?: Partial<MeetingOptions>
  timers?: Timers
  now?: () => number
}

interface Reply {
  id: string
  chunker: SentenceChunker
  /** Sentences fully spoken. */
  spoken: string
  /** The spoken part of the sentence being spoken now. */
  partial: string
  /** Sentences handed to the synthesizer and not finished yet. */
  outstanding: number
  generationDone: boolean
}

export const DEFAULT_OPTIONS: MeetingOptions = { endOfTurnMs: 1200, bargeIn: false }

/**
 * After the end-of-turn pause, how long to wait for the recognizer's final result when the
 * last words are still an interim guess. Past this, the turn is sent as it stands.
 */
export const FINAL_RESULT_WAIT_MS = 1500

const RECOGNIZER_ERRORS: Record<RecognizerError, string> = {
  'not-allowed': 'Microphone access is blocked. Allow it in your browser’s site settings, or type your replies.',
  'audio-capture': 'No microphone was found. Connect one, or type your replies.',
  network: 'Speech recognition can’t reach its service (Chrome needs an internet connection for it). You can type your replies.',
  'language-not-supported': 'Speech recognition doesn’t support the selected language in this browser.',
  service: 'Speech recognition is having trouble. You can type your replies.',
  unavailable: 'Speech recognition isn’t available. You can type your replies.',
}

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class MeetingController {
  private state: MeetingSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly options: MeetingOptions
  private readonly timers: Timers
  private readonly now: () => number
  private readonly clientName: string

  private reply: Reply | null = null
  /** A turn was sent and its reply hasn't started yet. */
  private awaitingReply = false
  /** Turns sent that the server hasn't acknowledged; replies starting before the ack are stale. */
  private unackedTurns = 0
  private utterance = { final: '', interim: '' }
  /** The pause ended the turn before its last words were final; waiting for the final result. */
  private awaitingFinal = false
  private silenceTimer: unknown = null
  private captionTimer: unknown = null
  private shareQueue: MaterialIn[] = []
  private joined = false
  private readySeen = false
  private disposed = false
  private noticeSeq = 0
  private itemSeq = 0
  private localSeq = 0

  private readonly deps: ControllerDeps

  constructor(deps: ControllerDeps) {
    this.deps = deps
    this.options = { ...DEFAULT_OPTIONS, ...deps.options }
    this.timers = deps.timers ?? defaultTimers
    this.now = deps.now ?? (() => Date.now())
    this.clientName = deps.session.briefing.persona.name.split(' ')[0] || 'The client'
    const micSupported = deps.recognizer.supported
    this.state = {
      phase: 'connecting',
      connection: 'connecting',
      transcript: [],
      caption: null,
      micOn: micSupported,
      micSupported,
      micBlocked: null,
      listening: false,
      notice: null,
      queuedShares: [],
      materials: deps.session.materials,
      startedAt: null,
      endedAt: null,
    }

    deps.transport.setEvents({
      onEvent: (event) => this.handleServerEvent(event),
      onState: (state, code) => this.handleConnection(state, code),
    })
    deps.synthesizer.setEvents({
      onStart: (item) => this.handleSpeechStart(item),
      onProgress: (item, chars) => this.handleSpeechProgress(item, chars),
      onEnd: (item) => this.handleSpeechEnd(item),
      onFailure: (message) => this.notify(message, 'info'),
    })
    deps.recognizer.setEvents({
      onResult: (finalText, interimText) => this.handleRecognition(finalText, interimText),
      onTurnEnd: (text) => this.handleTurnEnd(text),
      onError: (error, detail) => this.handleRecognizerError(error, detail),
      onListeningChange: (listening) => this.set({ listening }),
    })
    deps.recognizer.setEndOfTurnMs(this.options.endOfTurnMs)
  }

  // ------------------------------------------------------------------ store API (useSyncExternalStore)

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): MeetingSnapshot => this.state

  // ------------------------------------------------------------------ commands

  join(): void {
    if (this.joined || this.disposed) return
    this.joined = true
    this.deps.transport.connect()
    this.deps.recognizer.prepare() // e.g. connect to the speech service while the client opens
  }

  /** Stop the client mid-sentence. Returns false if they weren't talking. */
  interrupt(): boolean {
    if (!this.reply) return false
    this.cutReply()
    this.enterYourTurn()
    return true
  }

  sendText(raw: string): void {
    const text = raw.trim().slice(0, MAX_UTTERANCE_CHARS)
    if (!text || !this.canAct()) return
    this.clearUtterance()
    this.sendTurn({ type: 'user_message', text, source: 'typed' }, { kind: 'typed', text })
  }

  /** Share a document. While the client is talking it waits until they finish. */
  shareMaterial(material: MaterialIn): void {
    if (!this.canAct()) return
    if (this.utterance.final || this.utterance.interim) this.commitUtterance()
    if (this.reply || this.awaitingReply) {
      this.shareQueue.push(material)
      this.set({ queuedShares: this.shareQueue.map((m) => m.title || KIND_LABELS[m.kind]) })
      return
    }
    this.sendShare(material)
  }

  setMic(on: boolean): void {
    if (!this.state.micSupported || this.state.phase === 'ended') return
    if (on && this.state.micBlocked) return
    this.set({ micOn: on })
    if (!on) {
      this.deps.recognizer.stop()
      if (this.utterance.final || this.utterance.interim) this.commitUtterance()
      return
    }
    if (this.options.bargeIn || this.state.phase === 'your_turn' || this.state.phase === 'you_speaking') {
      this.deps.recognizer.start()
    }
  }

  /** Voice changes apply from the next sentence. */
  configureVoice(settings: Partial<VoiceSettings>): void {
    this.deps.synthesizer.configure(settings)
    if (settings.lang) this.deps.recognizer.lang = settings.lang
  }

  updateOptions(options: Partial<MeetingOptions>): void {
    const pauseChanged = options.endOfTurnMs !== undefined && options.endOfTurnMs !== this.options.endOfTurnMs
    Object.assign(this.options, options)
    if (pauseChanged && !this.disposed) this.deps.recognizer.setEndOfTurnMs(this.options.endOfTurnMs)
    if (!this.state.micOn || this.state.phase === 'ended') return
    const clientTurn = this.reply !== null || this.awaitingReply
    if (clientTurn && !this.options.bargeIn) this.deps.recognizer.stop()
    if (clientTurn && this.options.bargeIn) this.deps.recognizer.start()
  }

  dismissNotice(id: number): void {
    if (this.state.notice?.id === id) this.set({ notice: null })
  }

  /** Leave the meeting. The transcript stays available in the snapshot. */
  end(): void {
    if (this.state.phase === 'ended') return
    if (this.reply) this.cutReply()
    this.shutdown()
    this.set({ phase: 'ended', caption: null, listening: false, endedAt: this.now(), queuedShares: [] })
  }

  /** Release the mic, voice, and socket (on unmount). */
  dispose(): void {
    this.shutdown()
    this.listeners.clear()
  }

  // ------------------------------------------------------------------ server events

  private handleServerEvent(event: ServerEvent): void {
    if (this.disposed) return
    switch (event.type) {
      case 'ready':
        this.handleReady(event.session)
        break
      case 'message_saved':
        this.unackedTurns = Math.max(0, this.unackedTurns - 1)
        this.confirmEntry(event.message)
        break
      case 'material_added':
        this.unackedTurns = Math.max(0, this.unackedTurns - 1)
        this.set({
          materials: [...this.state.materials, event.material],
          transcript: [
            ...this.state.transcript,
            {
              id: event.message.id,
              speaker: 'you',
              kind: 'material',
              text: event.material.title,
              detail: KIND_LABELS[event.material.kind],
              interrupted: false,
              pending: false,
              at: this.now(),
            },
          ],
        })
        break
      case 'assistant_start':
        this.handleReplyStart(event.message_id)
        break
      case 'assistant_delta':
        if (this.reply?.id === event.message_id) {
          for (const chunk of this.reply.chunker.push(event.text)) this.queueSentence(chunk)
        }
        break
      case 'assistant_end':
        this.handleReplyEnd(event.message_id, event.error)
        break
      case 'error':
        if (event.code === 'not_found') this.set({ connection: 'gone' })
        if (event.code === 'llm_error') break // already reported with assistant_end
        this.notify(event.message, 'error')
        if ((event.code === 'bad_request' || event.code === 'limit') && this.unackedTurns > 0) {
          // The server rejected a turn we sent, so no reply is coming for it.
          this.unackedTurns--
          if (this.unackedTurns === 0 && this.awaitingReply && !this.reply) {
            this.awaitingReply = false
            this.enterYourTurn()
          }
        }
        break
      case 'pong':
        break
    }
  }

  private handleReady(session: SessionOut): void {
    this.set({ materials: session.materials })
    if (this.readySeen) return // a reconnect: local state is already current
    this.readySeen = true
    this.set({ startedAt: this.now() })
    if (session.messages.length === 0) {
      this.awaitingReply = true
      this.set({ phase: 'client_thinking' })
      this.send({ type: 'start' })
      return
    }
    // Rejoining a meeting that already started.
    this.set({ transcript: transcriptFromHistory(session) })
    this.enterYourTurn()
  }

  private handleReplyStart(id: string): void {
    if (this.unackedTurns > 0) return // a reply the server is about to cancel for our newer turn
    this.awaitingReply = false
    if (this.reply) this.cutReply()
    this.reply = { id, chunker: new SentenceChunker(), spoken: '', partial: '', outstanding: 0, generationDone: false }
    this.stopListeningForClientTurn()
    this.set({
      phase: 'client_thinking',
      transcript: [
        ...this.state.transcript,
        { id, speaker: 'client', kind: 'reply', text: '', interrupted: false, pending: true, at: this.now() },
      ],
    })
  }

  private handleReplyEnd(id: string, error: string | null): void {
    if (error) this.notify(error, 'error')
    const reply = this.reply
    if (!reply || reply.id !== id) {
      if (error && this.awaitingReply && this.unackedTurns === 0) {
        this.awaitingReply = false
        this.enterYourTurn()
      }
      return
    }
    for (const chunk of reply.chunker.flush()) this.queueSentence(chunk)
    reply.generationDone = true
    if (reply.outstanding === 0) this.finishReply()
  }

  private handleConnection(state: ConnectionState, code?: number): void {
    if (this.disposed) return
    if (state === 'open' || state === 'connecting') {
      this.set({ connection: state })
      return
    }
    if (state === 'reconnecting') {
      this.set({ connection: 'reconnecting' })
      // The server cancels an in-flight reply when the socket drops: no more text is coming.
      if (this.reply && !this.reply.generationDone) {
        for (const chunk of this.reply.chunker.flush()) this.queueSentence(chunk)
        this.reply.generationDone = true
        if (this.reply.outstanding === 0) this.finishReply()
      }
      if (this.awaitingReply) {
        this.awaitingReply = false
        this.unackedTurns = 0
        this.notify(`The connection dropped. If ${this.clientName} doesn’t answer, say that again.`, 'info')
        this.enterYourTurn()
      }
      return
    }
    // closed for good
    const status: ConnectionStatus =
      code === CLOSE_CODES.replaced ? 'replaced' : code === CLOSE_CODES.notFound || code === CLOSE_CODES.ended ? 'gone' : 'closed'
    if (this.reply) this.cutReply()
    this.deps.recognizer.stop()
    this.deps.synthesizer.cancel()
    this.set({ connection: status, caption: null, listening: false })
  }

  // ------------------------------------------------------------------ speaking

  private queueSentence(raw: string): void {
    const reply = this.reply
    const text = sanitizeForSpeech(raw)
    if (!reply || !text) return
    reply.outstanding++
    this.deps.synthesizer.speak({ id: `s${++this.itemSeq}`, messageId: reply.id, text })
  }

  private handleSpeechStart(item: SpeakItem): void {
    if (this.reply?.id !== item.messageId) return
    this.clearTimer('captionTimer')
    this.set({ phase: 'client_speaking', caption: { speaker: 'client', text: item.text, spokenChars: 0 } })
  }

  private handleSpeechProgress(item: SpeakItem, chars: number): void {
    const reply = this.reply
    if (!reply || reply.id !== item.messageId) return
    reply.partial = item.text.slice(0, chars).trim()
    this.set({
      caption: { speaker: 'client', text: item.text, spokenChars: chars },
      transcript: this.updateEntry(reply.id, { text: joinSpoken(reply.spoken, reply.partial) }),
    })
  }

  private handleSpeechEnd(item: SpeakItem): void {
    const reply = this.reply
    if (!reply || reply.id !== item.messageId) return
    reply.spoken = joinSpoken(reply.spoken, item.text)
    reply.partial = ''
    reply.outstanding--
    this.set({ transcript: this.updateEntry(reply.id, { text: reply.spoken }) })
    if (reply.outstanding === 0 && reply.generationDone) this.finishReply()
  }

  private finishReply(): void {
    const reply = this.reply
    if (!reply) return
    this.reply = null
    const transcript = reply.spoken
      ? this.updateEntry(reply.id, { text: reply.spoken, pending: false })
      : this.state.transcript.filter((entry) => entry.id !== reply.id) // nothing was said (an error)
    this.set({ transcript })
    this.scheduleCaptionClear(2500)
    const next = this.shareQueue.shift()
    if (next) {
      this.set({ queuedShares: this.shareQueue.map((m) => m.title || KIND_LABELS[m.kind]) })
      this.sendShare(next)
      return
    }
    this.enterYourTurn()
  }

  /** Stop the reply now; the server keeps only what was heard. */
  private cutReply(): void {
    const reply = this.reply
    if (!reply) return
    this.reply = null
    const heard = joinSpoken(reply.spoken, reply.partial)
    this.deps.synthesizer.cancel()
    this.send({ type: 'interrupt', message_id: reply.id, spoken_text: heard })
    this.set({ caption: null, transcript: this.updateEntry(reply.id, { text: heard, interrupted: true, pending: false }) })
  }

  // ------------------------------------------------------------------ listening

  private enterYourTurn(): void {
    if (this.disposed || this.state.phase === 'ended') return
    this.set({ phase: 'your_turn' })
    if (this.state.micOn && !this.state.micBlocked) this.deps.recognizer.start()
  }

  private stopListeningForClientTurn(): void {
    if (!this.options.bargeIn) this.deps.recognizer.stop()
  }

  private handleRecognition(finalText: string, interimText: string): void {
    if (this.disposed || this.state.phase === 'ended' || !this.state.micOn) return
    const heard = joinSpoken(finalText, interimText)
    if (!heard) return

    if ((this.reply !== null || this.awaitingReply) && !this.options.bargeIn) return
    if (this.reply) {
      // Barge-in: a couple of words from the participant interrupts the client.
      if (wordCount(joinSpoken(this.utterance.final, heard)) < 2) {
        if (finalText) this.utterance.final = joinSpoken(this.utterance.final, finalText)
        return
      }
      this.cutReply()
    }

    if (finalText) this.utterance.final = joinSpoken(this.utterance.final, finalText)
    this.utterance.interim = interimText
    const text = joinSpoken(this.utterance.final, this.utterance.interim)
    const turnDetecting = this.deps.recognizer.detectsTurnEnd
    this.clearTimer('captionTimer')
    this.set({
      // While a reply is still on its way (barge-in mode), the phase stays with the client.
      phase: this.awaitingReply ? this.state.phase : 'you_speaking',
      caption: {
        speaker: 'you',
        text,
        // A turn-detecting recognizer has nothing final until the turn ends; show all but the
        // still-settling last word as recognized.
        spokenChars: turnDetecting ? lastWordStart(text) : this.utterance.final.length,
      },
    })
    if (turnDetecting) return // the recognizer reports when the turn is over
    this.clearTimer('silenceTimer')
    if (this.awaitingFinal && !interimText) {
      this.commitUtterance() // the final result we were waiting for
      return
    }
    this.awaitingFinal = false // still talking: the pause starts over
    this.silenceTimer = this.timers.setTimeout(() => this.endOfTurn(), this.options.endOfTurnMs)
  }

  /** The participant paused long enough to end their turn. */
  private endOfTurn(): void {
    this.silenceTimer = null
    if (!this.utterance.interim) {
      this.commitUtterance()
      return
    }
    // The last words are still the recognizer's interim guess. Its final result is usually more
    // accurate and can lag behind (it comes from a network service), and stopping recognition
    // now would discard it. Ask for it and wait briefly.
    this.awaitingFinal = true
    this.deps.recognizer.finalize()
    this.silenceTimer = this.timers.setTimeout(() => {
      this.silenceTimer = null
      this.commitUtterance()
    }, FINAL_RESULT_WAIT_MS)
  }

  /** A turn-detecting recognizer says the participant has finished: `text` is their whole turn. */
  private handleTurnEnd(raw: string): void {
    if (this.disposed || this.state.phase === 'ended' || !this.state.micOn) return
    const text = raw.trim()
    if (!text) return
    if ((this.reply !== null || this.awaitingReply) && !this.options.bargeIn) return
    if (this.reply) {
      // Headphones mode, said over the client: a lone "mm-hm" is a backchannel, not an interruption.
      if (wordCount(text) < 2) return
      this.cutReply()
    }
    this.utterance = { final: text, interim: '' }
    this.commitUtterance()
  }

  private commitUtterance(): void {
    const text = joinSpoken(this.utterance.final, this.utterance.interim).trim().slice(0, MAX_UTTERANCE_CHARS)
    this.clearUtterance()
    if (!text) return
    this.sendTurn({ type: 'user_message', text, source: 'speech' }, { kind: 'speech', text })
  }

  private clearUtterance(): void {
    this.clearTimer('silenceTimer')
    this.awaitingFinal = false
    this.utterance = { final: '', interim: '' }
  }

  private handleRecognizerError(error: RecognizerError, detail?: string): void {
    const message = detail || RECOGNIZER_ERRORS[error]
    if (error === 'not-allowed' || error === 'audio-capture' || error === 'unavailable') {
      // Speaking can't work for the rest of the meeting: switch to typing.
      if (this.utterance.final || this.utterance.interim) this.commitUtterance()
      this.set({ micBlocked: message, micOn: false, listening: false })
      return
    }
    this.notify(message, 'error')
  }

  // ------------------------------------------------------------------ helpers

  private canAct(): boolean {
    return !this.disposed && this.state.phase !== 'ended' && this.state.connection !== 'replaced' && this.state.connection !== 'gone'
  }

  private sendTurn(event: ClientEvent, entry: { kind: 'speech' | 'typed'; text: string } | null): void {
    if (this.reply) this.cutReply()
    // Restart recognition so late results from this utterance can't leak into the next turn.
    this.deps.recognizer.stop()
    if (this.options.bargeIn && this.state.micOn && !this.state.micBlocked) this.deps.recognizer.start()
    this.unackedTurns++
    this.awaitingReply = true
    if (entry) {
      this.set({
        transcript: [
          ...this.state.transcript,
          {
            id: `local_${++this.localSeq}`,
            speaker: 'you',
            kind: entry.kind,
            text: entry.text,
            interrupted: false,
            pending: true,
            at: this.now(),
          },
        ],
      })
    }
    this.send(event)
    if (entry?.kind === 'speech') {
      // Keep the participant's last words on screen until the client starts answering.
      this.set({ phase: 'client_thinking', caption: { speaker: 'you', text: entry.text, spokenChars: entry.text.length } })
      this.scheduleCaptionClear(5000)
    } else {
      this.set({ phase: 'client_thinking', caption: null })
    }
  }

  private sendShare(material: MaterialIn): void {
    this.sendTurn({ type: 'share_material', material }, null)
  }

  private confirmEntry(message: ChatMessage): void {
    const index = this.state.transcript.findIndex(
      (entry) => entry.pending && entry.speaker === 'you' && entry.text === message.content,
    )
    if (index < 0) return
    const transcript = this.state.transcript.slice()
    transcript[index] = { ...transcript[index], id: message.id, pending: false }
    this.set({ transcript })
  }

  private updateEntry(id: string, patch: Partial<TranscriptEntry>): TranscriptEntry[] {
    return this.state.transcript.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry))
  }

  private scheduleCaptionClear(ms: number): void {
    this.clearTimer('captionTimer')
    this.captionTimer = this.timers.setTimeout(() => {
      this.captionTimer = null
      if (!this.reply) this.set({ caption: null })
    }, ms)
  }

  private clearTimer(name: 'silenceTimer' | 'captionTimer'): void {
    if (this[name] !== null) this.timers.clearTimeout(this[name])
    this[name] = null
  }

  private notify(text: string, tone: Notice['tone']): void {
    this.set({ notice: { id: ++this.noticeSeq, tone, text } })
  }

  private send(event: ClientEvent): void {
    this.deps.transport.send(event)
  }

  private shutdown(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearTimer('silenceTimer')
    this.clearTimer('captionTimer')
    this.deps.recognizer.dispose()
    this.deps.synthesizer.cancel()
    this.deps.transport.close()
  }

  private set(patch: Partial<MeetingSnapshot>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

/** Where the last word of `text` starts (0 for a single word). */
function lastWordStart(text: string): number {
  return text.trimEnd().lastIndexOf(' ') + 1
}

/** Rebuild the visible transcript from the server's history (when rejoining). */
export function transcriptFromHistory(session: SessionOut): TranscriptEntry[] {
  const materials = new Map(session.materials.map((m) => [m.id, m]))
  const entries: TranscriptEntry[] = []
  for (const message of session.messages) {
    const at = Date.parse(message.created_at)
    if (message.kind === 'event') continue
    if (message.role === 'assistant') {
      entries.push({
        id: message.id,
        speaker: 'client',
        kind: 'reply',
        text: message.content.replace(/—$/, '').trim(),
        interrupted: message.interrupted,
        pending: false,
        at,
      })
    } else if (message.kind === 'material') {
      const material = message.material_id ? materials.get(message.material_id) : undefined
      entries.push({
        id: message.id,
        speaker: 'you',
        kind: 'material',
        text: material?.title ?? 'Document',
        detail: material ? KIND_LABELS[material.kind] : undefined,
        interrupted: false,
        pending: false,
        at,
      })
    } else {
      entries.push({
        id: message.id,
        speaker: 'you',
        kind: message.kind === 'typed' ? 'typed' : 'speech',
        text: message.content,
        interrupted: false,
        pending: false,
        at,
      })
    }
  }
  return entries
}
