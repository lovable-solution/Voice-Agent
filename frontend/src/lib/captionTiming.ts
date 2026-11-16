/**
 * Estimates how far through a sentence the voice is, for voices that don't report word
 * boundaries (many network voices) and for captions-only mode. The estimate calibrates
 * itself from the real duration of each finished sentence.
 */
export class SpeechPaceEstimator {
  private charsPerSecond: number

  constructor(initialCharsPerSecond = 14.5) {
    this.charsPerSecond = initialCharsPerSecond
  }

  get pace(): number {
    return this.charsPerSecond
  }

  /** Expected duration of `text` at the given speech rate. */
  durationMs(text: string, rate = 1): number {
    return Math.max(700, (text.length / (this.charsPerSecond * rate)) * 1000 + 200)
  }

  /** Characters spoken after `elapsedMs`, snapped to the end of the current word. */
  charsAt(text: string, elapsedMs: number, rate = 1): number {
    const raw = Math.floor((elapsedMs / 1000) * this.charsPerSecond * rate)
    return wordEnd(text, Math.min(text.length, raw))
  }

  /** Learn from a sentence that finished speaking. */
  record(text: string, elapsedMs: number, rate = 1): void {
    if (text.length < 15 || elapsedMs < 400) return
    const measured = text.length / (elapsedMs / 1000) / rate
    if (measured < 5 || measured > 40) return // implausible: a stall or an early end event
    this.charsPerSecond = this.charsPerSecond * 0.7 + measured * 0.3
  }
}

/** Index just past the word containing `index` (or `index` itself at a space). */
export function wordEnd(text: string, index: number): number {
  if (index <= 0) return 0
  if (index >= text.length) return text.length
  let end = index
  while (end < text.length && !/\s/.test(text[end])) end++
  return end
}
