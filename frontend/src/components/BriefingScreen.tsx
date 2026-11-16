import { useState } from 'react'
import type { Preferences } from '../lib/preferences'
import { getRecognitionConstructor, speechSynthesisAvailable } from '../speech/webSpeech'
import type { SessionOut } from '../types'
import { Avatar } from './Avatar'
import { BackIcon, EyeIcon, SpeakerIcon } from './icons'
import { VoiceSelect, primeSpeech, speakSample, useVoices } from './VoiceControls'

interface BriefingScreenProps {
  session: SessionOut
  preferences: Preferences
  onPreferences(patch: Partial<Preferences>): void
  onJoin(): void
  onBack(): void
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  return (
    <section className="brief-list">
      <h3>{title}</h3>
      <ul>
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </section>
  )
}

export function BriefingScreen({ session, preferences, onPreferences, onJoin, onBack }: BriefingScreenProps) {
  const { briefing } = session
  const { persona } = briefing
  const [showQuestions, setShowQuestions] = useState(false)
  const voices = useVoices(preferences.lang)
  const voice = voices.find((v) => v.voiceURI === preferences.voiceURI) ?? voices[0]

  const canListen = getRecognitionConstructor() !== null
  const canSpeak = speechSynthesisAvailable()
  const secure = typeof window === 'undefined' || window.isSecureContext

  function join() {
    primeSpeech()
    onJoin()
  }

  return (
    <main className="page briefing">
      <button type="button" className="button button--ghost back-link" onClick={onBack}>
        <BackIcon size={18} /> Edit material
      </button>

      <header className="briefing__header">
        <p className="eyebrow">Your meeting</p>
        <h1>{briefing.meeting_title}</h1>
        <p className="lede">{briefing.situation}</p>
      </header>

      <div className="briefing__layout">
        <div className="briefing__main">
          <section className="card persona">
            <Avatar name={persona.name} size="xl" />
            <div>
              <h2 className="persona__name">{persona.name}</h2>
              <p className="persona__role">
                {persona.role} · {persona.company}
              </p>
              <p>{persona.company_summary}</p>
              <p className="muted">{persona.communication_style}</p>
            </div>
          </section>

          {(briefing.project_summary || briefing.partnership_summary) && (
            <section className="card summaries">
              {briefing.project_summary && (
                <div>
                  <h3>The project</h3>
                  <p>{briefing.project_summary}</p>
                </div>
              )}
              {briefing.partnership_summary && (
                <div>
                  <h3>Your partnership idea</h3>
                  <p>{briefing.partnership_summary}</p>
                </div>
              )}
            </section>
          )}

          <section className="card brief-grid">
            <List title="What they know" items={briefing.key_facts} />
            <List title="What they care about" items={briefing.priorities} />
            <List title="Likely concerns" items={briefing.concerns} />
            <List title="Their agenda" items={briefing.agenda} />
          </section>

          <section className="card">
            <div className="card__header">
              <div>
                <h3>Questions they plan to ask</h3>
                <p className="muted">Hidden so you can practice answering cold.</p>
              </div>
              <button type="button" className="button button--ghost button--small" onClick={() => setShowQuestions((v) => !v)}>
                <EyeIcon size={16} /> {showQuestions ? 'Hide' : 'Reveal'}
              </button>
            </div>
            {showQuestions && (
              <ol className="question-list">
                {briefing.questions_to_ask.map((question, index) => (
                  <li key={index}>{question}</li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <aside className="card audio-check" aria-label="Audio check">
          <h2>Before you join</h2>
          {!secure && (
            <p className="banner banner--warn">Open the app on localhost or over HTTPS, or the browser won’t allow the microphone.</p>
          )}
          {!canListen && (
            <p className="banner banner--warn">
              This browser can’t transcribe speech. Use Chrome, Edge, or Safari to talk; you can still type your replies here.
            </p>
          )}
          {!canSpeak && <p className="banner banner--warn">This browser can’t speak, so the client will answer in subtitles only.</p>}

          <div className="field">
            <label className="field__label" htmlFor="voice-select">
              Client’s voice
            </label>
            <VoiceSelect
              id="voice-select"
              voices={voices}
              value={preferences.voiceURI}
              onChange={(voiceURI) => onPreferences({ voiceURI })}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="voice-rate">
              Speaking speed <span className="muted">{preferences.rate.toFixed(2)}×</span>
            </label>
            <input
              id="voice-rate"
              type="range"
              min={0.8}
              max={1.4}
              step={0.05}
              value={preferences.rate}
              onChange={(event) => onPreferences({ rate: Number(event.target.value) })}
            />
          </div>
          <button
            type="button"
            className="button button--secondary"
            disabled={!canSpeak}
            onClick={() =>
              speakSample(
                `Hi, this is ${persona.name.split(' ')[0]} from ${persona.company}. Can you hear me clearly?`,
                voice,
                preferences.rate,
                preferences.lang,
              )
            }
          >
            <SpeakerIcon size={18} /> Test voice
          </button>

          <ul className="tips">
            <li>The client speaks first. When they finish, just talk; a short pause ends your turn.</li>
            <li>
              Press <kbd>Esc</kbd> to interrupt, <kbd>M</kbd> to mute, <kbd>C</kbd> for captions.
            </li>
            <li>Speakers instead of headphones? The mic pauses while the client talks, so they don’t hear themselves.</li>
          </ul>

          <button type="button" className="button button--primary button--large button--block" onClick={join}>
            Join the meeting
          </button>
        </aside>
      </div>
    </main>
  )
}
