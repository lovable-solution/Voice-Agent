import { useEffect, useState, useSyncExternalStore } from 'react'
import type { Preferences } from '../lib/preferences'
import { microphoneSupported } from '../speech/microphone'
import { BrowserRecognizer, type Recognizer } from '../speech/recognizer'
import { StreamingRecognizer } from '../speech/streamingRecognizer'
import { SpeechSynthesizer } from '../speech/synthesizer'
import { getRecognitionConstructor } from '../speech/webSpeech'
import type { SessionOut, SpeechEngine } from '../types'
import { MeetingController, type MeetingSnapshot } from './controller'
import { WebSocketTransport, meetingSocketUrl, speechSocketUrl } from './transport'

/** Whether this browser can turn the participant's speech into text with `engine`. */
export function canTranscribe(engine: SpeechEngine): boolean {
  const browserCan = getRecognitionConstructor() !== null
  return engine === 'deepgram' ? microphoneSupported() || browserCan : browserCan
}

/** Deepgram when the server offers it (falling back to the browser's own recognition if the
 * browser can't stream audio); otherwise the browser's. */
export function createRecognizer(session: SessionOut, lang: string): Recognizer {
  if (session.speech_engine === 'deepgram' && (microphoneSupported() || getRecognitionConstructor() === null)) {
    return new StreamingRecognizer({ url: speechSocketUrl(session.id) })
  }
  const recognizer = new BrowserRecognizer()
  recognizer.lang = lang
  return recognizer
}

export function createMeetingController(session: SessionOut, preferences: Preferences): MeetingController {
  const synthesizer = new SpeechSynthesizer()
  synthesizer.configure({
    voiceURI: preferences.voiceURI,
    rate: preferences.rate,
    muted: preferences.captionsOnly,
    lang: preferences.lang,
  })
  const recognizer = createRecognizer(session, preferences.lang)
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
 * effect and joins on the next tick: React's development double-mount disposes its throwaway
 * first controller synchronously, so that one never opens sockets (or a Deepgram stream) only
 * to drop them, which the dev proxy reports as "write ECONNABORTED".
 */
export function useMeeting(
  session: SessionOut,
  preferences: Preferences,
): { controller: MeetingController | null; snapshot: MeetingSnapshot | null } {
  const [controller, setController] = useState<MeetingController | null>(null)

  useEffect(() => {
    const meeting = createMeetingController(session, preferences)
    setController(meeting)
    const joining = setTimeout(() => meeting.join(), 0)
    return () => {
      clearTimeout(joining)
      meeting.dispose()
    }
    // Later preference changes are applied through the controller, not by recreating it.
  }, [session.id])

  const snapshot = useSyncExternalStore(
    controller ? controller.subscribe : emptySubscribe,
    controller ? controller.getSnapshot : () => null,
  )
  return { controller, snapshot }
}
