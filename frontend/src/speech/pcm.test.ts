import { describe, expect, it } from 'vitest'
import { CHUNK_SAMPLES, PcmEncoder } from './pcm'

function tone(length: number, value: (i: number) => number): Float32Array {
  return Float32Array.from({ length }, (_, i) => value(i))
}

/** Feed the samples in 128-sample frames, like an audio worklet does. */
function encode(encoder: PcmEncoder, samples: Float32Array): Int16Array[] {
  const chunks: Int16Array[] = []
  for (let i = 0; i < samples.length; i += 128) chunks.push(...encoder.push(samples.subarray(i, i + 128)))
  return chunks
}

describe('PcmEncoder', () => {
  it('turns 80 ms at 48 kHz into one 80 ms chunk at 16 kHz', () => {
    const chunks = encode(new PcmEncoder(48_000), tone(3_840, () => 0.5))
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toHaveLength(CHUNK_SAMPLES)
    expect(new Set(chunks[0])).toEqual(new Set([16_384])) // 0.5 of full scale
  })

  it('resamples 44.1 kHz too: three seconds become 48,000 samples', () => {
    const chunks = encode(new PcmEncoder(44_100), tone(3 * 44_100, (i) => Math.sin(i / 10) * 0.3))
    expect(chunks).toHaveLength(37) // 37 full chunks (47,360 samples); the last 640 wait for more audio
  })

  it('averages away content above the 8 kHz the output can carry', () => {
    // A 24 kHz tone at 48 kHz (+1, -1, ...) would alias into the speech band if samples were just dropped.
    const [chunk] = encode(new PcmEncoder(48_000), tone(3_840, (i) => (i % 2 ? -1 : 1)))
    expect(Math.max(...chunk.map(Math.abs))).toBeLessThanOrEqual(Math.ceil(32_767 / 3))
  })

  it('clamps to the 16-bit range', () => {
    const [chunk] = encode(new PcmEncoder(16_000), tone(CHUNK_SAMPLES, (i) => (i % 2 ? -3 : 3)))
    expect(chunk[0]).toBe(32_767)
    expect(chunk[1]).toBe(-32_768)
  })

  it('rejects input slower than the stream rate', () => {
    expect(() => new PcmEncoder(8_000)).toThrow(RangeError)
  })
})
