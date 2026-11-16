/**
 * Minimal typings for the Web Speech API's recognition half, which TypeScript's DOM
 * library doesn't ship (it's still prefixed in Chromium and Safari).
 */

export interface RecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}

export interface RecognitionResult {
  readonly isFinal: boolean
  readonly length: number
  readonly [index: number]: RecognitionAlternative
}

export interface RecognitionResultList {
  readonly length: number
  readonly [index: number]: RecognitionResult
}

export interface RecognitionResultEvent {
  readonly resultIndex: number
  readonly results: RecognitionResultList
}

export interface RecognitionErrorEvent {
  readonly error: string
  readonly message?: string
}

export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  onstart: (() => void) | null
  onend: (() => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onresult: ((event: RecognitionResultEvent) => void) | null
  start(): void
  stop(): void
  abort(): void
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export function getRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function speechSynthesisAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
}
