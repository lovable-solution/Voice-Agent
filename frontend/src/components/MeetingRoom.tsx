import { useEffect, useRef, useState } from 'react'
import type { Preferences } from '../lib/preferences'
import { formatDuration } from '../lib/transcript'
import type { MeetingSnapshot } from '../meeting/controller'
import { useMeeting } from '../meeting/useMeeting'
import { MicLevelMeter } from '../speech/micLevel'
import { getRecognitionConstructor } from '../speech/webSpeech'
import type { SessionOut } from '../types'
import { Avatar } from './Avatar'
import { Captions } from './Captions'
import { CaptionsIcon, CloseIcon, LeaveIcon, ListIcon, MicIcon, MicOffIcon, PaperclipIcon, SlidersIcon, StopIcon } from './icons'
import { SettingsDialog } from './SettingsDialog'
import { SharePanel } from './SharePanel'
import { TranscriptPanel } from './TranscriptPanel'

type PanelTab = 'transcript' | 'share' | 'brief'

interface MeetingRoomProps {
  session: SessionOut
  preferences: Preferences
  onPreferences(patch: Partial<Preferences>): void
  onEnded(snapshot: MeetingSnapshot): void
  onStartOver(): void
}

function useMicMeter(enabled: boolean): MicLevelMeter | null {
  const [meter, setMeter] = useState<MicLevelMeter | null>(null)
  useEffect(() => {
    if (getRecognitionConstructor() === null) return
    const instance = new MicLevelMeter()
    let cancelled = false
    void instance.start().then((access) => {
      if (!cancelled && access === 'granted') setMeter(instance)
    })
    return () => {
      cancelled = true
      instance.stop()
    }
  }, [])
  useEffect(() => meter?.setPaused(!enabled), [meter, enabled])
  return meter
}

function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="elapsed">{since ? formatDuration(now - since) : '0:00'}</span>
}

function isTyping(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null
  if (!element) return false
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
}

export function MeetingRoom({ session, preferences, onPreferences, onEnded, onStartOver }: MeetingRoomProps) {
  const { controller, snapshot } = useMeeting(session, preferences)
  const { persona } = session.briefing
  const clientFirst = persona.name.split(' ')[0] || persona.name
  const youName = session.user_name || 'You'

  const [tab, setTab] = useState<PanelTab>('transcript')
  const [panelOpen, setPanelOpen] = useState(() => window.matchMedia?.('(min-width: 1100px)').matches ?? true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [touch] = useState(() => window.matchMedia?.('(pointer: coarse)').matches ?? false)
  const meter = useMicMeter(snapshot?.micOn ?? false)
  const youTile = useRef<HTMLDivElement>(null)

  // Apply preference changes to the running meeting.
  useEffect(() => {
    controller?.configureVoice({
      voiceURI: preferences.voiceURI,
      rate: preferences.rate,
      muted: preferences.captionsOnly,
      lang: preferences.lang,
    })
  }, [controller, preferences.voiceURI, preferences.rate, preferences.captionsOnly, preferences.lang])
  useEffect(() => {
    controller?.updateOptions({ endOfTurnMs: preferences.endOfTurnMs, bargeIn: preferences.bargeIn })
  }, [controller, preferences.endOfTurnMs, preferences.bargeIn])

  // The mic level drives a CSS variable directly, without re-rendering.
  useEffect(() => {
    if (!meter) return
    return meter.subscribe((level) => youTile.current?.style.setProperty('--level', level.toFixed(3)))
  }, [meter])

  // Report the end once, on the transition; the snapshot at that moment is final.
  const phase = snapshot?.phase
  const latest = useRef({ snapshot, onEnded })
  latest.current = { snapshot, onEnded }
  useEffect(() => {
    const { snapshot: final, onEnded: report } = latest.current
    if (phase === 'ended' && final) report(final)
  }, [phase])

  const noticeId = snapshot?.notice?.id
  useEffect(() => {
    if (noticeId === undefined || !controller) return
    const timer = setTimeout(() => controller.dismissNotice(noticeId), 8000)
    return () => clearTimeout(timer)
  }, [controller, noticeId])

  // Keyboard shortcuts: Esc / Space interrupt, M mutes, C toggles captions.
  useEffect(() => {
    if (!controller || settingsOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || isTyping(event.target)) return
      const state = controller.getSnapshot()
      if (event.key === 'Escape' || (event.key === ' ' && state.phase === 'client_speaking')) {
        if (controller.interrupt()) event.preventDefault()
      } else if (event.key === 'm' || event.key === 'M') {
        controller.setMic(!state.micOn)
      } else if (event.key === 'c' || event.key === 'C') {
        onPreferences({ captionsOn: !preferences.captionsOn })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [controller, settingsOpen, onPreferences, preferences.captionsOn])

  if (!controller || !snapshot) {
    return (
      <main className="meeting meeting--loading">
        <span className="spinner" aria-hidden="true" /> Joining the meeting…
      </main>
    )
  }

  const { connection } = snapshot
  const live = connection !== 'replaced' && connection !== 'gone' && connection !== 'closed'
  const clientSpeaking = snapshot.phase === 'client_speaking'
  const clientThinking = snapshot.phase === 'client_thinking' || snapshot.phase === 'connecting'
  const youSpeaking = snapshot.phase === 'you_speaking'

  function status(s: MeetingSnapshot): string {
    switch (s.phase) {
      case 'connecting':
        return 'Connecting…'
      case 'client_thinking':
        return `${clientFirst} is thinking…`
      case 'client_speaking':
        if (preferences.bargeIn) return `${clientFirst} is speaking. Start talking to cut in.`
        return touch ? `${clientFirst} is speaking. Tap Interrupt to cut in.` : `${clientFirst} is speaking. Press Esc or Interrupt to cut in.`
      case 'you_speaking':
        return 'Listening… pause when you’re done.'
      case 'your_turn':
        if (!s.micSupported) return 'Your turn. Type your reply (this browser can’t transcribe speech).'
        if (s.micBlocked) return 'Your turn. Type your reply.'
        if (!s.micOn) return 'Your turn. Your mic is off: unmute or type a reply.'
        return 'Your turn. Go ahead and speak.'
      case 'ended':
        return 'Meeting ended.'
    }
  }

  const openTab = (next: PanelTab) => {
    setTab(next)
    setPanelOpen(true)
  }

  return (
    <main className={`meeting${panelOpen ? ' meeting--panel-open' : ''}`}>
      <section className="meeting__stage" aria-label="Meeting">
        <header className="meeting__header">
          <div className="meeting__title">
            <h1>{session.briefing.meeting_title}</h1>
            <p>
              with {persona.name}, {persona.role} at {persona.company}
            </p>
          </div>
          <div className="meeting__meta">
            <Elapsed since={snapshot.startedAt} />
            <span className={`pill pill--${connection}`}>
              {connection === 'open' ? 'Live' : connection === 'reconnecting' ? 'Reconnecting…' : connection === 'connecting' ? 'Connecting…' : 'Offline'}
            </span>
          </div>
        </header>

        {snapshot.notice && (
          <div className={`toast toast--${snapshot.notice.tone}`} role={snapshot.notice.tone === 'error' ? 'alert' : 'status'}>
            <span>{snapshot.notice.text}</span>
            <button type="button" className="button button--ghost button--icon" aria-label="Dismiss" onClick={() => controller.dismissNotice(snapshot.notice!.id)}>
              <CloseIcon size={16} />
            </button>
          </div>
        )}

        <div className="tiles">
          <div className={`tile tile--client${clientSpeaking ? ' is-speaking' : ''}${clientThinking ? ' is-thinking' : ''}`}>
            <div className="tile__avatar">
              <span className="tile__ring" />
              <Avatar name={persona.name} size="xl" />
            </div>
            <div className="tile__label">
              <strong>{persona.name}</strong>
              <span>{clientThinking ? 'thinking…' : clientSpeaking ? 'speaking' : persona.company}</span>
            </div>
            {clientThinking && (
              <span className="thinking-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            )}
          </div>

          <div ref={youTile} className={`tile tile--you${youSpeaking ? ' is-speaking' : ''}${snapshot.micOn ? '' : ' is-muted'}`}>
            <div className="tile__avatar">
              <span className="tile__level" />
              <Avatar name={youName} size="lg" tone="you" />
            </div>
            <div className="tile__label">
              <strong>{youName}</strong>
              <span>{!snapshot.micSupported ? 'typing only' : snapshot.micOn ? (snapshot.listening ? 'mic on' : 'mic standby') : 'muted'}</span>
            </div>
          </div>
        </div>

        {preferences.captionsOn && (
          <Captions caption={snapshot.caption} clientName={clientFirst} youName={youName} size={preferences.captionSize} />
        )}

        <p className="status-line" role="status" aria-live="polite">
          {status(snapshot)}
        </p>

        {snapshot.micBlocked && <p className="banner banner--warn meeting__banner">{snapshot.micBlocked}</p>}

        <nav className="controls" aria-label="Meeting controls">
          <button
            type="button"
            className={`control${snapshot.micOn ? '' : ' control--off'}`}
            onClick={() => controller.setMic(!snapshot.micOn)}
            disabled={!snapshot.micSupported || Boolean(snapshot.micBlocked) || !live}
            aria-pressed={snapshot.micOn}
            title="Microphone (M)"
          >
            {snapshot.micOn ? <MicIcon /> : <MicOffIcon />}
            <span>{snapshot.micOn ? 'Mute' : 'Unmute'}</span>
          </button>
          <button
            type="button"
            className="control control--accent"
            onClick={() => controller.interrupt()}
            disabled={!clientSpeaking}
            title="Interrupt (Esc)"
          >
            <StopIcon />
            <span>Interrupt</span>
          </button>
          <button
            type="button"
            className={`control${preferences.captionsOn ? ' control--on' : ''}`}
            onClick={() => onPreferences({ captionsOn: !preferences.captionsOn })}
            aria-pressed={preferences.captionsOn}
            title="Subtitles (C)"
          >
            <CaptionsIcon />
            <span>Subtitles</span>
          </button>
          <button type="button" className="control" onClick={() => openTab('share')} disabled={!live} title="Share a document">
            <PaperclipIcon />
            <span>Share</span>
          </button>
          <button
            type="button"
            className={`control${panelOpen ? ' control--on' : ''}`}
            onClick={() => setPanelOpen((open) => !open)}
            aria-pressed={panelOpen}
            title="Transcript and notes"
          >
            <ListIcon />
            <span>Transcript</span>
          </button>
          <button type="button" className="control" onClick={() => setSettingsOpen(true)} title="Settings">
            <SlidersIcon />
            <span>Settings</span>
          </button>
          <button type="button" className="control control--danger" onClick={() => controller.end()} title="Leave the meeting">
            <LeaveIcon />
            <span>Leave</span>
          </button>
        </nav>

        {!live && (
          <div className="overlay" role="alertdialog" aria-labelledby="overlay-title">
            <div className="overlay__card">
              <h2 id="overlay-title">
                {connection === 'replaced' ? 'This meeting is open in another tab' : 'The meeting was disconnected'}
              </h2>
              <p>
                {connection === 'replaced'
                  ? 'Only one window can be in the meeting at a time. Close this one, or end the meeting here.'
                  : connection === 'gone'
                    ? 'The server no longer has this meeting (it may have restarted). Your transcript is still here.'
                    : 'The connection to the server was lost and could not be restored.'}
              </p>
              <div className="overlay__actions">
                <button type="button" className="button button--secondary" onClick={() => controller.end()}>
                  See transcript
                </button>
                <button type="button" className="button button--primary" onClick={onStartOver}>
                  Start a new meeting
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <aside className="panel" aria-label="Meeting panel" hidden={!panelOpen}>
        <div className="panel__tabs" role="tablist">
          {(
            [
              ['transcript', 'Transcript'],
              ['share', 'Share'],
              ['brief', 'Brief'],
            ] as [PanelTab, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`tab-${value}`}
              aria-selected={tab === value}
              aria-controls={`tabpanel-${value}`}
              className={tab === value ? 'is-active' : ''}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
          <button type="button" className="button button--ghost button--icon panel__close" aria-label="Close panel" onClick={() => setPanelOpen(false)}>
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="panel__body" role="tabpanel" id={`tabpanel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === 'transcript' && (
            <TranscriptPanel
              entries={snapshot.transcript}
              clientName={persona.name}
              youName={youName}
              onSend={(text) => controller.sendText(text)}
              disabled={!live}
            />
          )}
          {tab === 'share' && (
            <SharePanel
              clientName={clientFirst}
              materials={snapshot.materials}
              queued={snapshot.queuedShares}
              disabled={!live}
              onShare={(material) => {
                controller.shareMaterial(material)
                setTab('transcript')
              }}
            />
          )}
          {tab === 'brief' && (
            <div className="brief-panel">
              <h3>Situation</h3>
              <p>{session.briefing.situation}</p>
              {session.briefing.agenda.length > 0 && (
                <>
                  <h3>Their agenda</h3>
                  <ul>
                    {session.briefing.agenda.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {session.briefing.key_facts.length > 0 && (
                <>
                  <h3>What they know</h3>
                  <ul>
                    {session.briefing.key_facts.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
              {session.briefing.concerns.length > 0 && (
                <>
                  <h3>Likely concerns</h3>
                  <ul>
                    {session.briefing.concerns.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      </aside>

      {settingsOpen && <SettingsDialog preferences={preferences} onChange={onPreferences} onClose={() => setSettingsOpen(false)} />}
    </main>
  )
}
