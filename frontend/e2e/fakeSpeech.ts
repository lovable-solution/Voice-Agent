/**
 * Replaces the browser's speech APIs with scriptable fakes, injected before the app loads.
 *
 *   window.__speech.say(text)   speak into the "microphone" (interim results, then final)
 *   window.__speech.spoken      every sentence the client's voice spoke
 *   window.__speech.listening   whether recognition is running
 *   window.__speech.wordMs      how long the fake voice takes per word
 *   window.__speech.finalOnStop the final text recognition returns when stopped mid-guess
 *                               (like Chrome, stop() finalizes pending words; abort() drops them)
 */
export function installFakeSpeech(): void {
  interface FakeUtterance {
    text: string
    voice: unknown
    lang: string
    rate: number
    volume: number
    onstart: ((e: object) => void) | null
    onend: ((e: object) => void) | null
    onerror: ((e: { error: string }) => void) | null
    onboundary: ((e: { name: string; charIndex: number; charLength: number }) => void) | null
  }

  const state = {
    spoken: [] as string[],
    listening: false,
    wordMs: 60,
    finalOnStop: null as string | null,
    current: null as FakeRecognition | null,
    say: async (_text: string) => {},
    hear: (_text: string, _isFinal: boolean) => {},
  }
  ;(window as unknown as { __speech: typeof state }).__speech = state

  class FakeRecognition {
    lang = 'en-US'
    continuous = false
    interimResults = false
    maxAlternatives = 1
    onstart: (() => void) | null = null
    onend: (() => void) | null = null
    onerror: ((e: { error: string }) => void) | null = null
    onresult: ((e: unknown) => void) | null = null
    active = false
    /** The latest interim guess not yet followed by a final result. */
    pending: string | null = null

    start() {
      if (this.active) throw new DOMException('already started', 'InvalidStateError')
      this.active = true
      state.current = this
      state.listening = true
      setTimeout(() => this.onstart?.(), 5)
    }
    stop() {
      const pending = this.pending
      if (!this.active || pending === null) {
        this.end()
        return
      }
      // Like Chrome: deliver a final result for the pending words (a moment later), then end.
      this.pending = null
      setTimeout(() => {
        this.emit(state.finalOnStop ?? pending, true)
        this.end()
      }, 20)
    }
    abort() {
      this.pending = null
      this.end()
    }
    end() {
      if (!this.active) return
      this.active = false
      if (state.current === this) {
        state.current = null
        state.listening = false
      }
      setTimeout(() => this.onend?.(), 5)
    }
    emit(text: string, isFinal: boolean) {
      this.pending = isFinal ? null : text
      const result = Object.assign([{ transcript: text, confidence: 0.92 }], { isFinal })
      this.onresult?.({ resultIndex: 0, results: [result] })
    }
  }

  state.hear = (text: string, isFinal: boolean) => {
    if (!state.current) throw new Error('The app is not listening right now')
    state.current.emit(text, isFinal)
  }

  state.say = async (text: string) => {
    const recognition = state.current
    if (!recognition) throw new Error('The app is not listening right now')
    const words = text.split(' ')
    for (let i = 1; i < words.length; i++) {
      recognition.emit(words.slice(0, i).join(' '), false)
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    recognition.emit(text, true)
  }

  const w = window as unknown as Record<string, unknown>
  w.SpeechRecognition = FakeRecognition
  w.webkitSpeechRecognition = FakeRecognition

  class Utterance implements FakeUtterance {
    text: string
    voice: unknown = null
    lang = ''
    rate = 1
    volume = 1
    onstart = null
    onend = null
    onerror = null
    onboundary = null
    constructor(text = '') {
      this.text = text
    }
  }
  w.SpeechSynthesisUtterance = Utterance

  const voices = [
    { name: 'Test Natural Voice', lang: 'en-US', voiceURI: 'test-natural', localService: true, default: true },
    { name: 'Test British Voice', lang: 'en-GB', voiceURI: 'test-gb', localService: true, default: false },
  ]
  let current: FakeUtterance | null = null
  let timers: ReturnType<typeof setTimeout>[] = []
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    getVoices: () => voices,
    addEventListener() {},
    removeEventListener() {},
    pause() {},
    resume() {},
    speak(utterance: FakeUtterance) {
      if (!utterance.text.trim()) {
        setTimeout(() => utterance.onend?.({}), 0) // the gesture-priming utterance
        return
      }
      current = utterance
      synth.speaking = true
      state.spoken.push(utterance.text)
      let t = 10
      timers.push(setTimeout(() => utterance.onstart?.({}), t))
      for (const match of utterance.text.matchAll(/\S+/g)) {
        t += state.wordMs
        const charIndex = match.index ?? 0
        const charLength = match[0].length
        timers.push(setTimeout(() => utterance.onboundary?.({ name: 'word', charIndex, charLength }), t))
      }
      timers.push(
        setTimeout(() => {
          if (current === utterance) {
            current = null
            synth.speaking = false
          }
          utterance.onend?.({})
        }, t + state.wordMs),
      )
    },
    cancel() {
      timers.forEach(clearTimeout)
      timers = []
      const utterance = current
      current = null
      synth.speaking = false
      utterance?.onerror?.({ error: 'interrupted' })
    },
  }
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true })
}
