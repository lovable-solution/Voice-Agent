// Mirrors backend/app/schemas.py.

export type MaterialKind = 'job_posting' | 'partnership' | 'notes'
export type Personality = 'friendly' | 'neutral' | 'skeptical' | 'demanding'
export type MessageKind = 'speech' | 'typed' | 'event' | 'material' | 'reply'
/** Who transcribes the participant: Deepgram (through the server) or the browser itself. */
export type SpeechEngine = 'deepgram' | 'browser'

export const MAX_MATERIAL_CHARS = 60_000
export const MAX_UTTERANCE_CHARS = 4_000

export const KIND_LABELS: Record<MaterialKind, string> = {
  job_posting: 'Job posting',
  partnership: 'Partnership ideas',
  notes: 'Notes',
}

export interface MaterialIn {
  kind: MaterialKind
  title?: string | null
  content: string
}

export interface Material {
  id: string
  kind: MaterialKind
  title: string
  content: string
  shared_during_meeting: boolean
  added_at: string
}

export interface ClientPersona {
  name: string
  role: string
  company: string
  company_summary: string
  communication_style: string
}

export interface Briefing {
  persona: ClientPersona
  meeting_title: string
  situation: string
  project_summary: string
  partnership_summary: string
  key_facts: string[]
  priorities: string[]
  concerns: string[]
  questions_to_ask: string[]
  agenda: string[]
  opening_line: string
  speech_keyterms: string[]
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  kind: MessageKind
  content: string
  interrupted: boolean
  material_id: string | null
  created_at: string
}

export interface SessionOut {
  id: string
  created_at: string
  user_name: string | null
  personality: Personality
  briefing: Briefing
  materials: Material[]
  messages: ChatMessage[]
  speech_engine: SpeechEngine
}

export interface SessionCreate {
  materials: MaterialIn[]
  user_name?: string | null
  user_background?: string | null
  client_name?: string | null
  personality: Personality
}

export interface Health {
  status: 'ok'
  chat_model: string
  briefing_model: string
  credentials_configured: boolean
  speech_engine: SpeechEngine
}

export interface ExtractedDocument {
  filename: string
  text: string
  characters: number
}

// ------------------------------------------------------------------ WebSocket protocol

export type ClientEvent =
  | { type: 'start' }
  | { type: 'user_message'; text: string; source: 'speech' | 'typed' }
  | { type: 'interrupt'; message_id: string; spoken_text: string }
  | { type: 'share_material'; material: MaterialIn }
  | { type: 'ping' }

export type ServerEvent =
  | { type: 'ready'; session: SessionOut }
  | { type: 'message_saved'; message: ChatMessage }
  | { type: 'material_added'; material: Material; message: ChatMessage }
  | { type: 'assistant_start'; message_id: string }
  | { type: 'assistant_delta'; message_id: string; text: string }
  | { type: 'assistant_end'; message_id: string; text: string; error: string | null }
  | { type: 'error'; code: string; message: string; retryable: boolean }
  | { type: 'pong' }
