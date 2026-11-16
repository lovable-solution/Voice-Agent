import { useEffect, useState } from 'react'
import { loadVoices, rankVoices } from '../speech/voices'
import { speechSynthesisAvailable } from '../speech/webSpeech'

/** The browser's voices for `lang`, best first. */
export function useVoices(lang: string): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  useEffect(() => {
    if (!speechSynthesisAvailable()) return
    let cancelled = false
    const refresh = () => {
      void loadVoices().then((all) => {
        if (!cancelled) setVoices(rankVoices(all, lang))
      })
    }
    refresh()
    window.speechSynthesis.addEventListener('voiceschanged', refresh)
    return () => {
      cancelled = true
      window.speechSynthesis.removeEventListener('voiceschanged', refresh)
    }
  }, [lang])
  return voices
}

/** Speak a short line with the chosen voice. */
export function speakSample(text: string, voice: SpeechSynthesisVoice | undefined, rate: number, lang: string): void {
  if (!speechSynthesisAvailable()) return
  const synth = window.speechSynthesis
  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  if (voice) utterance.voice = voice
  utterance.lang = voice?.lang ?? lang
  utterance.rate = rate
  synth.speak(utterance)
}

/**
 * Some browsers (Safari, mobile) only allow speech that starts inside a user gesture.
 * Call this from the click that joins the meeting.
 */
export function primeSpeech(): void {
  if (!speechSynthesisAvailable()) return
  const utterance = new SpeechSynthesisUtterance(' ')
  utterance.volume = 0
  window.speechSynthesis.speak(utterance)
}

interface VoiceSelectProps {
  id: string
  voices: SpeechSynthesisVoice[]
  value: string | null
  onChange(voiceURI: string | null): void
}

export function VoiceSelect({ id, voices, value, onChange }: VoiceSelectProps) {
  if (!voices.length) {
    return (
      <select id={id} className="input" disabled>
        <option>Browser default voice</option>
      </select>
    )
  }
  const selected = voices.some((v) => v.voiceURI === value) ? value! : voices[0].voiceURI
  return (
    <select id={id} className="input" value={selected} onChange={(event) => onChange(event.target.value)}>
      {voices.map((voice) => (
        <option key={voice.voiceURI} value={voice.voiceURI}>
          {voice.name} ({voice.lang}){voice.localService ? '' : ' · online'}
        </option>
      ))}
    </select>
  )
}
