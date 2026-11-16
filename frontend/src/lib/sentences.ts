/**
 * Splits streamed text into speakable chunks, so speech can start after the first
 * sentence instead of waiting for the whole reply.
 */

// Words that end in a period without ending the sentence (compared lowercase, without the final period).
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e', 'inc', 'ltd', 'co',
  'corp', 'approx', 'u.s', 'u.k', 'a.m', 'p.m',
])

const SENTENCE_END = /[.!?…]+["'”’)\]]*(?=\s)/g
const SOFT_BREAK = /[,;:—–]\s/g

function isAbbreviation(text: string, punctuationIndex: number): boolean {
  if (text[punctuationIndex] !== '.') return false
  const before = text.slice(0, punctuationIndex)
  const word = /([A-Za-z.]+)$/.exec(before)?.[1]
  if (!word) return false
  if (word.length === 1) return true // an initial, as in "J. Smith"
  return ABBREVIATIONS.has(word.toLowerCase())
}

export class SentenceChunker {
  private buffer = ''
  private readonly maxChunk: number

  // 180 chars is ~12 s of speech: Chrome's network voices can cut off utterances longer than ~15 s.
  constructor(maxChunk = 180) {
    this.maxChunk = maxChunk
  }

  /** Add streamed text; returns the chunks that are now complete. */
  push(text: string): string[] {
    this.buffer += text
    return this.drain()
  }

  /** The stream ended: return everything left. */
  flush(): string[] {
    const chunks = this.drain()
    const rest = this.buffer.trim()
    this.buffer = ''
    if (rest) chunks.push(...this.splitLong(rest))
    return chunks
  }

  reset(): void {
    this.buffer = ''
  }

  private drain(): string[] {
    const chunks: string[] = []
    for (;;) {
      const cut = this.boundary()
      if (cut < 0) break
      const chunk = this.buffer.slice(0, cut).trim()
      this.buffer = this.buffer.slice(cut).replace(/^\s+/, '')
      if (chunk) chunks.push(chunk)
    }
    return chunks
  }

  private boundary(): number {
    const text = this.buffer
    const newline = text.indexOf('\n')
    let sentence = -1
    SENTENCE_END.lastIndex = 0
    for (let match = SENTENCE_END.exec(text); match; match = SENTENCE_END.exec(text)) {
      if (!isAbbreviation(text, match.index)) {
        sentence = match.index + match[0].length
        break
      }
    }
    const candidates = [newline >= 0 ? newline + 1 : -1, sentence].filter((n) => n > 0)
    if (candidates.length) {
      const cut = Math.min(...candidates)
      if (cut <= this.maxChunk) return cut
    }
    // No boundary yet, or the first sentence is too long to speak in one go.
    return text.length > this.maxChunk ? this.softBreak(text) : -1
  }

  /** Where to split an over-long run of text: the last comma-like break, else the last space. */
  private softBreak(text: string): number {
    const window = text.slice(0, this.maxChunk)
    let cut = -1
    SOFT_BREAK.lastIndex = 0
    for (let match = SOFT_BREAK.exec(window); match; match = SOFT_BREAK.exec(window)) {
      cut = match.index + 1
    }
    if (cut < this.maxChunk * 0.4) {
      const space = window.lastIndexOf(' ')
      cut = space > 0 ? space : this.maxChunk
    }
    return cut
  }

  private splitLong(text: string): string[] {
    const parts: string[] = []
    let rest = text
    while (rest.length > this.maxChunk) {
      const cut = this.softBreak(rest)
      parts.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut).trim()
    }
    if (rest) parts.push(rest)
    return parts
  }
}
