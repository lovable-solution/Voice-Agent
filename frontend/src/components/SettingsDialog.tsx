import { useEffect, useRef } from 'react'
import type { CaptionSize, Preferences } from '../lib/preferences'
import { CloseIcon, SpeakerIcon } from './icons'
import { VoiceSelect, speakSample, useVoices } from './VoiceControls'

const LANGUAGES: [string, string][] = [
  ['en-US', 'English (United States)'],
  ['en-GB', 'English (United Kingdom)'],
  ['en-AU', 'English (Australia)'],
  ['en-CA', 'English (Canada)'],
  ['en-IN', 'English (India)'],
  ['en-IE', 'English (Ireland)'],
  ['en-NZ', 'English (New Zealand)'],
  ['en-ZA', 'English (South Africa)'],
]

const SIZES: CaptionSize[] = ['small', 'medium', 'large']

interface SettingsDialogProps {
  preferences: Preferences
  onChange(patch: Partial<Preferences>): void
  onClose(): void
}

export function SettingsDialog({ preferences, onChange, onClose }: SettingsDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const voices = useVoices(preferences.lang)

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) element.showModal()
    return () => element?.close()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="settings-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose() // backdrop click
      }}
    >
      <div className="dialog__body">
        <header className="dialog__header">
          <h2 id="settings-title">Meeting settings</h2>
          <button type="button" className="button button--ghost button--icon" onClick={onClose} aria-label="Close settings">
            <CloseIcon size={18} />
          </button>
        </header>

        <section className="settings-group">
          <h3>Client’s voice</h3>
          <div className="field">
            <label className="field__label" htmlFor="settings-voice">
              Voice
            </label>
            <div className="inline">
              <VoiceSelect
                id="settings-voice"
                voices={voices}
                value={preferences.voiceURI}
                onChange={(voiceURI) => onChange({ voiceURI })}
              />
              <button
                type="button"
                className="button button--secondary button--icon"
                aria-label="Test voice"
                onClick={() =>
                  speakSample(
                    'This is how I sound.',
                    voices.find((v) => v.voiceURI === preferences.voiceURI) ?? voices[0],
                    preferences.rate,
                    preferences.lang,
                  )
                }
              >
                <SpeakerIcon size={18} />
              </button>
            </div>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="settings-rate">
              Speaking speed <span className="muted">{preferences.rate.toFixed(2)}×</span>
            </label>
            <input
              id="settings-rate"
              type="range"
              min={0.8}
              max={1.4}
              step={0.05}
              value={preferences.rate}
              onChange={(event) => onChange({ rate: Number(event.target.value) })}
            />
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={preferences.captionsOnly}
              onChange={(event) => onChange({ captionsOnly: event.target.checked })}
            />
            <span>
              <strong>Captions only</strong>
              <span className="muted">Mute the voice; captions keep a natural speaking pace.</span>
            </span>
          </label>
        </section>

        <section className="settings-group">
          <h3>Subtitles</h3>
          <label className="toggle">
            <input type="checkbox" checked={preferences.captionsOn} onChange={(event) => onChange({ captionsOn: event.target.checked })} />
            <span>
              <strong>Show live subtitles</strong>
            </span>
          </label>
          <div className="field">
            <span className="field__label" id="caption-size-label">
              Size
            </span>
            <div className="segmented" role="radiogroup" aria-labelledby="caption-size-label">
              {SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  role="radio"
                  aria-checked={preferences.captionSize === size}
                  className={preferences.captionSize === size ? 'is-active' : ''}
                  onClick={() => onChange({ captionSize: size })}
                >
                  {size[0].toUpperCase() + size.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="settings-group">
          <h3>Your microphone</h3>
          <div className="field">
            <label className="field__label" htmlFor="settings-pause">
              Pause that ends your turn <span className="muted">{(preferences.endOfTurnMs / 1000).toFixed(1)} s</span>
            </label>
            <input
              id="settings-pause"
              type="range"
              min={600}
              max={3000}
              step={100}
              value={preferences.endOfTurnMs}
              onChange={(event) => onChange({ endOfTurnMs: Number(event.target.value) })}
            />
            <p className="field__hint">Raise it if you get cut off while thinking mid-sentence.</p>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={preferences.bargeIn} onChange={(event) => onChange({ bargeIn: event.target.checked })} />
            <span>
              <strong>I’m wearing headphones</strong>
              <span className="muted">Keep listening while the client talks, so you can interrupt just by speaking.</span>
            </span>
          </label>
          <div className="field">
            <label className="field__label" htmlFor="settings-lang">
              Speech language
            </label>
            <select id="settings-lang" className="input" value={preferences.lang} onChange={(event) => onChange({ lang: event.target.value })}>
              {LANGUAGES.map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </section>
      </div>
    </dialog>
  )
}
