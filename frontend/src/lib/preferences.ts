import { useCallback, useState } from 'react'

export type CaptionSize = 'small' | 'medium' | 'large'

export interface Preferences {
  voiceURI: string | null
  rate: number
  /** No audio; captions advance at speaking pace. */
  captionsOnly: boolean
  captionsOn: boolean
  captionSize: CaptionSize
  /** Silence (ms) that ends your turn. */
  endOfTurnMs: number
  /** Speaking over the client interrupts them. Only safe with headphones. */
  bargeIn: boolean
  lang: string
}

export const DEFAULT_PREFERENCES: Preferences = {
  voiceURI: null,
  rate: 1.05,
  captionsOnly: false,
  captionsOn: true,
  captionSize: 'medium',
  endOfTurnMs: 1200,
  bargeIn: false,
  lang: 'en-US',
}

const KEY = 'client-meeting-simulator.preferences.v1'

// Storage can be unavailable (private windows, blocked site data): fall back to defaults.
export function loadPreferences(): Preferences {
  try {
    const raw = window.localStorage.getItem(KEY)
    if (raw) return { ...DEFAULT_PREFERENCES, ...(JSON.parse(raw) as Partial<Preferences>) }
  } catch {
    // ignore
  }
  return DEFAULT_PREFERENCES
}

function savePreferences(preferences: Preferences): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(preferences))
  } catch {
    // ignore
  }
}

export function usePreferences(): [Preferences, (patch: Partial<Preferences>) => void] {
  const [preferences, setPreferences] = useState(loadPreferences)
  const update = useCallback((patch: Partial<Preferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...patch }
      savePreferences(next)
      return next
    })
  }, [])
  return [preferences, update]
}

/** Per-viewer draft of the setup form, so pasted material survives a reload. */
export function loadDraft<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(`client-meeting-simulator.draft.${key}`)
    if (raw) return { ...fallback, ...(JSON.parse(raw) as Partial<T>) }
  } catch {
    // ignore
  }
  return fallback
}

export function saveDraft(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(`client-meeting-simulator.draft.${key}`, JSON.stringify(value))
  } catch {
    // ignore
  }
}
