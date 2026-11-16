import type { ClientEvent, ServerEvent } from '../types'

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface TransportEvents {
  onEvent(event: ServerEvent): void
  onState(state: ConnectionState, closeCode?: number): void
}

export interface MeetingTransport {
  setEvents(events: TransportEvents): void
  connect(): void
  /** Sends now, or as soon as the connection (re)opens. */
  send(event: ClientEvent): void
  close(): void
}

/** Close codes after which reconnecting is pointless (see backend/app/realtime.py). */
export const CLOSE_CODES = {
  normal: 1000,
  forbiddenOrigin: 4403,
  notFound: 4404,
  replaced: 4409,
  ended: 4410,
} as const
const TERMINAL = new Set<number>(Object.values(CLOSE_CODES))
const MAX_RECONNECTS = 6

export function meetingSocketUrl(sessionId: string, location: Location = window.location): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/api/sessions/${encodeURIComponent(sessionId)}/ws`
}

export class WebSocketTransport implements MeetingTransport {
  private socket: WebSocket | null = null
  private events: TransportEvents = { onEvent() {}, onState() {} }
  private outbox: ClientEvent[] = []
  private attempts = 0
  private closedByUs = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private readonly url: string

  constructor(url: string) {
    this.url = url
  }

  setEvents(events: TransportEvents): void {
    this.events = events
  }

  connect(): void {
    this.closedByUs = false
    this.open()
  }

  send(event: ClientEvent): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event))
    else this.outbox.push(event)
  }

  close(): void {
    this.closedByUs = true
    this.outbox = []
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const socket = this.socket
    this.socket = null
    socket?.close(CLOSE_CODES.normal)
  }

  private open(): void {
    this.events.onState(this.attempts ? 'reconnecting' : 'connecting')
    const socket = new WebSocket(this.url)
    this.socket = socket

    socket.onopen = () => {
      if (this.socket !== socket) return
      this.attempts = 0
      this.events.onState('open')
      const pending = this.outbox
      this.outbox = []
      for (const event of pending) socket.send(JSON.stringify(event))
    }
    socket.onmessage = (message) => {
      if (this.socket !== socket || typeof message.data !== 'string') return
      let event: ServerEvent
      try {
        event = JSON.parse(message.data) as ServerEvent
      } catch {
        return
      }
      this.events.onEvent(event)
    }
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = null
      if (this.closedByUs) return
      if (TERMINAL.has(event.code) || this.attempts >= MAX_RECONNECTS) {
        this.events.onState('closed', event.code)
        return
      }
      this.attempts++
      this.events.onState('reconnecting', event.code)
      this.retryTimer = setTimeout(() => this.open(), Math.min(500 * 2 ** (this.attempts - 1), 8000))
    }
  }
}
