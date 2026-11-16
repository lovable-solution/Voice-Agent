import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Preferences } from '../lib/preferences'
import { BrowserRecognizer } from '../speech/recognizer'
import { SpeechSynthesizer } from '../speech/synthesizer'
import type { SessionOut } from '../types'
import { MeetingController, type MeetingSnapshot } from './controller'
import { WebSocketTransport, meetingSocketUrl } from './transport'

export function createMeetingController(session: SessionOut, preferences: Preferences): MeetingController {
  const synthesizer = new SpeechSynthesizer()
  synthesizer.configure({
    voiceURI: preferences.voiceURI,
    rate: preferences.rate,
    muted: preferences.captionsOnly,
    lang: preferences.lang,
  })
  const recognizer = new BrowserRecognizer()
  recognizer.lang = preferences.lang
  return new MeetingController({
    session,
    transport: new WebSocketTransport(meetingSocketUrl(session.id)),
    synthesizer,
    recognizer,
    options: { endOfTurnMs: preferences.endOfTurnMs, bargeIn: preferences.bargeIn },
  })
}

const emptySubscribe = () => () => {}

/**
 * Runs a meeting for the lifetime of the component. The controller is created inside the
 * effect, so React's development double-mount opens and disposes a throwaway one cleanly.
 */
export function useMeeting(
  session: SessionOut,
  preferences: Preferences,
): { controller: MeetingController | null; snapshot: MeetingSnapshot | null } {
  const [controller, setController] = useState<MeetingController | null>(null)

  useEffect(() => {
    const meeting = createMeetingController(session, preferences)
    setController(meeting)
    meeting.join()
    return () => meeting.dispose()
    // Later preference changes are applied through the controller, not by recreating it.
  }, [session.id])

  const snapshot = useSyncExternalStore(
    controller ? controller.subscribe : emptySubscribe,
    controller ? controller.getSnapshot : () => null,
  )
  return { controller, snapshot }
}
