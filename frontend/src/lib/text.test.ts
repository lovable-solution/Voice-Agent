import { describe, expect, it } from 'vitest'
import { SpeechPaceEstimator, wordEnd } from './captionTiming'
import { SentenceChunker } from './sentences'
import { joinSpoken, sanitizeForSpeech } from './speechText'

function chunkAll(pieces: string[], maxChunk?: number): string[] {
  const chunker = new SentenceChunker(maxChunk)
  const out: string[] = []
  for (const piece of pieces) out.push(...chunker.push(piece))
  out.push(...chunker.flush())
  return out
}

describe('SentenceChunker', () => {
  it('emits each sentence as soon as the next one starts', () => {
    const chunker = new SentenceChunker()
    expect(chunker.push('Hi Alex, thanks for')).toEqual([])
    expect(chunker.push(' joining. So')).toEqual(['Hi Alex, thanks for joining.'])
    expect(chunker.push(' what brings you here? I')).toEqual(['So what brings you here?'])
    expect(chunker.flush()).toEqual(['I'])
  })

  it('does not split on abbreviations, initials, or decimals', () => {
    expect(chunkAll(['Mr. Smith from the U.S. office has 3.5 years, e.g. on J. Doe’s team. Next.'])).toEqual([
      'Mr. Smith from the U.S. office has 3.5 years, e.g. on J. Doe’s team.',
      'Next.',
    ])
  })

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(chunkAll(['She said "that works." (Really!) Okay'])).toEqual(['She said "that works."', '(Really!)', 'Okay'])
  })

  it('treats line breaks as boundaries', () => {
    expect(chunkAll(['First line\n\nSecond line'])).toEqual(['First line', 'Second line'])
  })

  it('splits overly long sentences at a natural break', () => {
    const long = 'We need the dashboard rebuilt, the booking flow redesigned, the map integrated with live data, and the documents section reworked so customers can actually find things'
    const chunks = chunkAll([long + '. Thanks.'], 80)
    expect(chunks.every((c) => c.length <= 80)).toBe(true)
    expect(chunks.join(' ')).toBe(long + '. Thanks.')
    expect(chunks[0]).toBe('We need the dashboard rebuilt, the booking flow redesigned,')
  })
})

describe('sanitizeForSpeech', () => {
  it('removes markdown and stage directions but keeps the words', () => {
    expect(sanitizeForSpeech('**Budget:** about *forty* thousand. *laughs* Right (pauses) so.')).toBe(
      'Budget: about forty thousand. Right so.',
    )
    expect(sanitizeForSpeech('- First point\n2. Second point')).toBe('First point Second point')
    expect(sanitizeForSpeech('See [our posting](https://x.y) and `config` 🚀🎉')).toBe('See our posting and config')
  })

  it('leaves ordinary parentheses and snake_case alone', () => {
    expect(sanitizeForSpeech('It takes (about three months) with my_var set.')).toBe(
      'It takes (about three months) with my_var set.',
    )
  })

  it('joins spoken pieces with single spaces', () => {
    expect(joinSpoken('', 'a')).toBe('a')
    expect(joinSpoken('a', '')).toBe('a')
    expect(joinSpoken('a', 'b')).toBe('a b')
  })
})

describe('SpeechPaceEstimator', () => {
  it('estimates progress snapped to word ends', () => {
    const pace = new SpeechPaceEstimator(10)
    expect(pace.charsAt('hello wonderful world', 700)).toBe(15) // 7 chars in -> end of "wonderful"
    expect(pace.charsAt('hello', 10_000)).toBe(5)
    expect(wordEnd('hello world', 0)).toBe(0)
    expect(wordEnd('hello world', 5)).toBe(5)
  })

  it('calibrates from measured durations and ignores outliers', () => {
    const pace = new SpeechPaceEstimator(10)
    pace.record('x'.repeat(40), 2000) // 20 chars/s
    expect(pace.pace).toBeCloseTo(13)
    pace.record('x'.repeat(40), 100) // too short to trust
    pace.record('x'.repeat(40), 60_000) // a stall
    expect(pace.pace).toBeCloseTo(13)
  })
})
