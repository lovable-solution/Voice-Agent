import { useCallback, useState } from 'react'
import { api } from './api'
import { BriefingScreen } from './components/BriefingScreen'
import { EndedScreen } from './components/EndedScreen'
import { MeetingRoom } from './components/MeetingRoom'
import { SetupScreen } from './components/SetupScreen'
import { usePreferences } from './lib/preferences'
import type { MeetingSnapshot, TranscriptEntry } from './meeting/controller'
import type { SessionOut } from './types'

type Screen =
  | { name: 'setup' }
  | { name: 'briefing'; session: SessionOut }
  | { name: 'meeting'; session: SessionOut }
  | { name: 'ended'; session: SessionOut; transcript: TranscriptEntry[]; startedAt: number | null; endedAt: number | null }

export function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'setup' })
  const [preferences, updatePreferences] = usePreferences()

  const startOver = useCallback((session?: SessionOut) => {
    if (session) void api.deleteSession(session.id).catch(() => {})
    setScreen({ name: 'setup' })
    window.scrollTo(0, 0)
  }, [])

  const handleEnded = useCallback((session: SessionOut, snapshot: MeetingSnapshot) => {
    setScreen({
      name: 'ended',
      session,
      transcript: snapshot.transcript,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
    })
  }, [])

  switch (screen.name) {
    case 'setup':
      return <SetupScreen onReady={(session) => setScreen({ name: 'briefing', session })} />
    case 'briefing':
      return (
        <BriefingScreen
          session={screen.session}
          preferences={preferences}
          onPreferences={updatePreferences}
          onJoin={() => setScreen({ name: 'meeting', session: screen.session })}
          onBack={() => startOver(screen.session)}
        />
      )
    case 'meeting':
      return (
        <MeetingRoom
          session={screen.session}
          preferences={preferences}
          onPreferences={updatePreferences}
          onEnded={(snapshot) => handleEnded(screen.session, snapshot)}
          onStartOver={() => startOver(screen.session)}
        />
      )
    case 'ended':
      return (
        <EndedScreen
          session={screen.session}
          transcript={screen.transcript}
          startedAt={screen.startedAt}
          endedAt={screen.endedAt}
          onNewMeeting={() => startOver(screen.session)}
        />
      )
  }
}
