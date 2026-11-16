import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { EXAMPLE_BACKGROUND, EXAMPLE_JOB_POSTING, EXAMPLE_PARTNERSHIP } from '../lib/examples'
import { loadDraft, saveDraft } from '../lib/preferences'
import { MAX_MATERIAL_CHARS, type Health, type MaterialIn, type Personality, type SessionOut } from '../types'
import { MaterialField } from './MaterialField'

interface Draft {
  jobPosting: string
  partnership: string
  userName: string
  userBackground: string
  clientName: string
  personality: Personality
}

const EMPTY: Draft = {
  jobPosting: '',
  partnership: '',
  userName: '',
  userBackground: '',
  clientName: '',
  personality: 'neutral',
}

const PERSONALITIES: { value: Personality; label: string; description: string }[] = [
  { value: 'friendly', label: 'Friendly', description: 'Warm and encouraging' },
  { value: 'neutral', label: 'Neutral', description: 'Businesslike, needs convincing' },
  { value: 'skeptical', label: 'Skeptical', description: 'Wants evidence and specifics' },
  { value: 'demanding', label: 'Demanding', description: 'Direct, pushes on price and time' },
]

interface SetupScreenProps {
  onReady(session: SessionOut): void
}

export function SetupScreen({ onReady }: SetupScreenProps) {
  const [draft, setDraft] = useState<Draft>(() => loadDraft('setup', EMPTY))
  const [health, setHealth] = useState<Health | null>(null)
  const [backendDown, setBackendDown] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => saveDraft('setup', draft), 300)
    return () => clearTimeout(timer)
  }, [draft])

  useEffect(() => {
    api
      .health()
      .then((result) => {
        setHealth(result)
        setBackendDown(null)
      })
      .catch((err: Error) => setBackendDown(err.message))
  }, [])

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }))
  const hasMaterial = Boolean(draft.jobPosting.trim() || draft.partnership.trim())
  const tooLong = draft.jobPosting.length > MAX_MATERIAL_CHARS || draft.partnership.length > MAX_MATERIAL_CHARS

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!hasMaterial || tooLong || submitting) return
    const materials: MaterialIn[] = []
    if (draft.jobPosting.trim()) materials.push({ kind: 'job_posting', content: draft.jobPosting })
    if (draft.partnership.trim()) materials.push({ kind: 'partnership', content: draft.partnership })
    setSubmitting(true)
    setError(null)
    try {
      const session = await api.createSession({
        materials,
        user_name: draft.userName || null,
        user_background: draft.userBackground || null,
        client_name: draft.clientName || null,
        personality: draft.personality,
      })
      onReady(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setSubmitting(false)
    }
  }

  function loadExample() {
    setDraft((current) => ({
      ...current,
      jobPosting: EXAMPLE_JOB_POSTING,
      partnership: EXAMPLE_PARTNERSHIP,
      userBackground: current.userBackground || EXAMPLE_BACKGROUND,
    }))
  }

  return (
    <main className="page setup">
      <header className="setup__hero">
        <p className="eyebrow">Client Meeting Simulator</p>
        <h1>Rehearse your next client meeting, out loud.</h1>
        <p className="lede">
          Paste a job posting, your partnership ideas, or both. An AI client studies them, then meets with you by
          voice, with live subtitles, so you can practice pitching, answering tough questions, and negotiating.
        </p>
      </header>

      {backendDown && (
        <div className="banner banner--error" role="alert">
          {backendDown}
        </div>
      )}
      {health && !health.credentials_configured && (
        <div className="banner banner--warn" role="alert">
          No Anthropic API key is configured on the server. Add <code>ANTHROPIC_API_KEY</code> to{' '}
          <code>backend/.env</code> and restart the backend.
        </div>
      )}

      <form className="setup__form" onSubmit={submit} aria-busy={submitting}>
        <section className="card">
          <div className="card__header">
            <div>
              <h2>What’s the meeting about?</h2>
              <p className="muted">Add at least one. You can share more documents during the meeting too.</p>
            </div>
            <button type="button" className="button button--ghost button--small" onClick={loadExample} disabled={submitting}>
              Load an example
            </button>
          </div>
          <div className="material-grid">
            <MaterialField
              label="Job posting or project"
              hint="The client becomes the person who posted it, and knows every detail."
              placeholder="Paste the job posting: title, scope, requirements, budget, timeline…"
              value={draft.jobPosting}
              onChange={(jobPosting) => update({ jobPosting })}
              disabled={submitting}
            />
            <MaterialField
              label="Partnership ideas"
              hint="The client reads your proposal before the meeting and weighs it for their company."
              placeholder="Describe the partnership: what you offer, revenue share, roles, IP, a pilot…"
              value={draft.partnership}
              onChange={(partnership) => update({ partnership })}
              disabled={submitting}
            />
          </div>
        </section>

        <div className="setup__row">
          <section className="card">
            <h2>About you</h2>
            <p className="muted">Optional. The client will know this about you.</p>
            <div className="field">
              <label className="field__label" htmlFor="user-name">
                Your name
              </label>
              <input
                id="user-name"
                className="input"
                value={draft.userName}
                maxLength={80}
                autoComplete="name"
                placeholder="e.g. Alex Kim"
                onChange={(event) => update({ userName: event.target.value })}
                disabled={submitting}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="user-background">
                Your background
              </label>
              <textarea
                id="user-background"
                className="input textarea"
                rows={3}
                maxLength={4000}
                value={draft.userBackground}
                placeholder="e.g. Freelance React developer, 8 years, built two logistics dashboards"
                onChange={(event) => update({ userBackground: event.target.value })}
                disabled={submitting}
              />
            </div>
          </section>

          <section className="card">
            <h2>The client</h2>
            <p className="muted">How should they come across?</p>
            <fieldset className="field">
              <legend className="field__label">Temperament</legend>
              <div className="choice-grid" role="radiogroup">
                {PERSONALITIES.map((option) => (
                  <label key={option.value} className="choice">
                    <input
                      type="radio"
                      name="personality"
                      value={option.value}
                      checked={draft.personality === option.value}
                      onChange={() => update({ personality: option.value })}
                      disabled={submitting}
                    />
                    <span className="choice__label">{option.label}</span>
                    <span className="choice__description">{option.description}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="field">
              <label className="field__label" htmlFor="client-name">
                Client’s name
              </label>
              <input
                id="client-name"
                className="input"
                value={draft.clientName}
                maxLength={80}
                placeholder="Leave blank to use the posting’s contact or invent one"
                onChange={(event) => update({ clientName: event.target.value })}
                disabled={submitting}
              />
            </div>
          </section>
        </div>

        {error && (
          <div className="banner banner--error" role="alert">
            {error}
          </div>
        )}

        <div className="setup__actions">
          <button type="submit" className="button button--primary button--large" disabled={!hasMaterial || tooLong || submitting}>
            {submitting ? (
              <>
                <span className="spinner" aria-hidden="true" /> Your client is reading the material…
              </>
            ) : (
              'Prepare the meeting'
            )}
          </button>
          {!hasMaterial && <span className="muted">Add a job posting or partnership ideas to continue.</span>}
        </div>
      </form>
    </main>
  )
}
