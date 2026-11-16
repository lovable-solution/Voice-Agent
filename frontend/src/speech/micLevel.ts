export type MicAccess = 'granted' | 'denied' | 'unavailable'

/**
 * Opens the microphone (which also asks for permission up front) and reports the input
 * level, so the participant can see the mic is working.
 */
export class MicLevelMeter {
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<(level: number) => void>()
  private disposed = false
  private level = 0
  private paused = false

  async start(): Promise<MicAccess> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return 'unavailable'
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (error) {
      const name = error instanceof DOMException ? error.name : ''
      return name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable'
    }
    if (this.disposed) {
      stream.getTracks().forEach((track) => track.stop())
      return 'granted'
    }
    this.stream = stream
    try {
      const context = new AudioContext()
      void context.resume()
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      context.createMediaStreamSource(stream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      this.context = context
      this.timer = setInterval(() => {
        let level = 0
        if (!this.paused) {
          analyser.getByteTimeDomainData(samples)
          let sum = 0
          for (const sample of samples) {
            const x = (sample - 128) / 128
            sum += x * x
          }
          level = Math.min(1, Math.sqrt(sum / samples.length) * 5)
        }
        this.level = this.level * 0.55 + level * 0.45
        for (const listener of this.listeners) listener(this.level)
      }, 60)
    } catch {
      // No Web Audio: permission is still granted, there's just no meter.
    }
    return 'granted'
  }

  /** While paused (mic muted) the meter reads zero. */
  setPaused(paused: boolean): void {
    this.paused = paused
  }

  subscribe(listener: (level: number) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  stop(): void {
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    void this.context?.close().catch(() => {})
    this.context = null
    this.listeners.clear()
  }
}
