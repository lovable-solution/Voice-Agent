/** Deepgram's recommended streaming format: 16 kHz, 16-bit, mono PCM, about 80 ms per message. */
export const STREAM_SAMPLE_RATE = 16_000
export const CHUNK_SAMPLES = 1_280 // 80 ms at 16 kHz (2,560 bytes)

/**
 * Turns microphone audio (float samples at the device's rate, usually 44.1 or 48 kHz) into
 * 16 kHz, 16-bit PCM chunks of `CHUNK_SAMPLES`. Each output sample is the average of the input
 * samples it covers, a simple low-pass filter that keeps hiss above the speech band from folding
 * down into it when the rate drops.
 */
export class PcmEncoder {
  readonly inputRate: number
  /** Input samples per output sample. */
  private readonly step: number
  /** Input samples taken into the output sample being built, carrying the fraction over. */
  private position = 0
  private sum = 0
  private count = 0
  private chunk: Int16Array<ArrayBuffer> = new Int16Array(CHUNK_SAMPLES)
  private filled = 0

  constructor(inputRate: number) {
    if (!(inputRate >= STREAM_SAMPLE_RATE)) throw new RangeError(`Unsupported input sample rate: ${inputRate} Hz`)
    this.inputRate = inputRate
    this.step = inputRate / STREAM_SAMPLE_RATE
  }

  /** Add input samples; returns the chunks completed by them. */
  push(samples: Float32Array): Int16Array<ArrayBuffer>[] {
    const chunks: Int16Array<ArrayBuffer>[] = []
    for (let i = 0; i < samples.length; i++) {
      this.sum += samples[i]
      this.count++
      this.position++
      if (this.position >= this.step) {
        this.position -= this.step
        this.emit(this.sum / this.count, chunks)
        this.sum = 0
        this.count = 0
      }
    }
    return chunks
  }

  private emit(value: number, chunks: Int16Array<ArrayBuffer>[]): void {
    const clamped = Math.max(-1, Math.min(1, value))
    this.chunk[this.filled++] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
    if (this.filled === CHUNK_SAMPLES) {
      chunks.push(this.chunk)
      this.chunk = new Int16Array(CHUNK_SAMPLES)
      this.filled = 0
    }
  }
}
