/**
 * The microphone as a stream of raw samples, for speech recognition that runs elsewhere
 * (Deepgram, through the server). An AudioWorklet copies the samples off the audio thread.
 */

export interface Microphone {
  stop(): void
}

export type SamplesListener = (samples: Float32Array, sampleRate: number) => void

/** The microphone can't be used; `reason` matches the recognizer's error kinds. */
export class MicrophoneUnavailable extends Error {
  readonly reason: 'not-allowed' | 'audio-capture'

  constructor(reason: 'not-allowed' | 'audio-capture') {
    super(reason === 'not-allowed' ? 'Microphone access was denied.' : 'No usable microphone was found.')
    this.reason = reason
  }
}

// Runs on the audio thread: forwards the (mono) input in batches of 2,048 samples, ~43 ms at 48 kHz.
const TAP_PROCESSOR = `
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buffer = new Float32Array(2048)
    this.length = 0
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer[this.length++] = channel[i]
        if (this.length === this.buffer.length) {
          this.port.postMessage(this.buffer, [this.buffer.buffer])
          this.buffer = new Float32Array(2048)
          this.length = 0
        }
      }
    }
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)
`

export function microphoneSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  )
}

export async function openMicrophone(onSamples: SamplesListener): Promise<Microphone> {
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ''
    throw new MicrophoneUnavailable(name === 'NotAllowedError' || name === 'SecurityError' ? 'not-allowed' : 'audio-capture')
  }

  const context = new AudioContext()
  const release = () => {
    stream.getTracks().forEach((track) => track.stop())
    void context.close().catch(() => {})
  }
  try {
    const url = URL.createObjectURL(new Blob([TAP_PROCESSOR], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = context.createMediaStreamSource(stream)
    const tap = new AudioWorkletNode(context, 'pcm-tap', { channelCount: 1, channelCountMode: 'explicit' })
    // A node that leads nowhere may never run, so route it to the output through a muted gain.
    const mute = context.createGain()
    mute.gain.value = 0
    source.connect(tap)
    tap.connect(mute)
    mute.connect(context.destination)
    tap.port.onmessage = (event: MessageEvent<Float32Array>) => onSamples(event.data, context.sampleRate)
    void context.resume().catch(() => {})
    return {
      stop() {
        tap.port.onmessage = null
        source.disconnect()
        tap.disconnect()
        release()
      },
    }
  } catch (error) {
    release()
    throw error
  }
}
