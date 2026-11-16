import { downloadText, formatDuration, slugify, transcriptToMarkdown } from '../lib/transcript'
import type { TranscriptEntry } from '../meeting/controller'
import type { SessionOut } from '../types'
import { DownloadIcon } from './icons'
import { TranscriptItem } from './TranscriptPanel'

interface EndedScreenProps {
  session: SessionOut
  transcript: TranscriptEntry[]
  startedAt: number | null
  endedAt: number | null
  onNewMeeting(): void
}

export function EndedScreen({ session, transcript, startedAt, endedAt, onNewMeeting }: EndedScreenProps) {
  const { persona } = session.briefing
  const youName = session.user_name || 'You'
  const yourTurns = transcript.filter((e) => e.speaker === 'you' && e.kind !== 'material').length
  const clientTurns = transcript.filter((e) => e.speaker === 'client').length
  const shared = transcript.filter((e) => e.kind === 'material').length

  function download() {
    const markdown = transcriptToMarkdown(session, transcript, startedAt, endedAt)
    downloadText(`${slugify(session.briefing.meeting_title)}-transcript.md`, markdown)
  }

  return (
    <main className="page ended">
      <header>
        <p className="eyebrow">Meeting ended</p>
        <h1>{session.briefing.meeting_title}</h1>
        <p className="lede">
          with {persona.name}, {persona.role} at {persona.company}
        </p>
      </header>

      <dl className="stats">
        <div>
          <dt>Duration</dt>
          <dd>{startedAt && endedAt ? formatDuration(endedAt - startedAt) : '–'}</dd>
        </div>
        <div>
          <dt>Your turns</dt>
          <dd>{yourTurns}</dd>
        </div>
        <div>
          <dt>{persona.name.split(' ')[0]}’s turns</dt>
          <dd>{clientTurns}</dd>
        </div>
        <div>
          <dt>Documents shared</dt>
          <dd>{shared}</dd>
        </div>
      </dl>

      <div className="ended__actions">
        <button type="button" className="button button--primary" onClick={download} disabled={!transcript.length}>
          <DownloadIcon size={18} /> Download transcript
        </button>
        <button type="button" className="button button--secondary" onClick={onNewMeeting}>
          Start a new meeting
        </button>
      </div>

      <section className="card">
        <h2>Transcript</h2>
        {transcript.length ? (
          <ol className="transcript__list">
            {transcript.map((entry) => (
              <TranscriptItem key={entry.id} entry={entry} clientName={persona.name} youName={youName} />
            ))}
          </ol>
        ) : (
          <p className="muted">Nothing was said in this meeting.</p>
        )}
      </section>
    </main>
  )
}
