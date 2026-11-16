import { speechSynthesisAvailable } from './webSpeech'

export interface VoiceLike {
  name: string
  lang: string
  voiceURI: string
  localService: boolean
}

function normalizeLang(lang: string): string {
  return lang.replace('_', '-').toLowerCase()
}

/** Higher is better. Voices in other languages score below zero. */
export function voiceScore(voice: VoiceLike, lang: string): number {
  const wanted = normalizeLang(lang)
  const have = normalizeLang(voice.lang)
  let score = 0
  if (have === wanted) score += 100
  else if (have.split('-')[0] === wanted.split('-')[0]) score += 60
  else score -= 200

  const name = voice.name
  if (/natural|neural/i.test(name)) score += 40
  if (/premium|enhanced/i.test(name)) score += 30
  if (/google/i.test(name)) score += 25
  if (/online/i.test(name)) score += 10
  if (/\b(samantha|ava|allison|susan|zoe|evan|nathan|tom|serena|daniel)\b/i.test(name)) score += 10
  if (/espeak|mbrola|festival/i.test(name)) score -= 60
  return score
}

export function rankVoices<T extends VoiceLike>(voices: readonly T[], lang: string): T[] {
  return voices
    .map((voice, index) => ({ voice, index, score: voiceScore(voice, lang) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.voice)
}

/** The browser's voices; Chrome populates the list asynchronously. */
export function loadVoices(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  if (!speechSynthesisAvailable()) return Promise.resolve([])
  const synth = window.speechSynthesis
  const voices = synth.getVoices()
  if (voices.length) return Promise.resolve(voices)
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener('voiceschanged', done)
      clearTimeout(timer)
      resolve(synth.getVoices())
    }
    const timer = setTimeout(done, timeoutMs)
    synth.addEventListener('voiceschanged', done)
  })
}
