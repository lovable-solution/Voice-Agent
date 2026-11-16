import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { TranscriptEntry } from '../meeting/controller'
import { MAX_UTTERANCE_CHARS } from '../types'
import { SendIcon } from './icons'

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export const TranscriptItem = memo(function TranscriptItem({
  entry,
  clientName,
  youName,
}: {
  entry: TranscriptEntry
  clientName: string
  youName: string
}) {
  if (entry.kind === 'material') {
    return (
      <li className="transcript__event">
        <span>
          {youName} shared <strong>“{entry.text}”</strong>
          {entry.detail ? ` · ${entry.detail}` : ''}
        </span>
      </li>
    )
  }
  const speaker = entry.speaker === 'client' ? clientName : youName
  return (
    <li className={`transcript__entry transcript__entry--${entry.speaker}${entry.pending ? ' is-pending' : ''}`}>
      <div className="transcript__meta">
        <span className="transcript__speaker">{speaker}</span>
        <time dateTime={new Date(entry.at).toISOString()}>{clock(entry.at)}</time>
        {entry.kind === 'typed' && <span className="tag">typed</span>}
        {entry.interrupted && <span className="tag tag--warn">interrupted</span>}
      </div>
      <p className="transcript__text">{entry.text || (entry.pending ? '…' : '(cut off before speaking)')}</p>
    </li>
  )
})

interface TranscriptPanelProps {
  entries: TranscriptEntry[]
  clientName: string
  youName: string
  onSend(text: string): void
  disabled: boolean
}

export function TranscriptPanel({ entries, clientName, youName, onSend, disabled }: TranscriptPanelProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const [draft, setDraft] = useState('')

  useLayoutEffect(() => {
    const list = listRef.current
    if (list && stickToBottom.current) list.scrollTop = list.scrollHeight
  }, [entries])

  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const onScroll = () => {
      stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48
    }
    list.addEventListener('scroll', onScroll, { passive: true })
    return () => list.removeEventListener('scroll', onScroll)
  }, [])

  function submit(event: FormEvent) {
    event.preventDefault()
    const text = draft.trim()
    if (!text || disabled) return
    onSend(text)
    setDraft('')
    stickToBottom.current = true
  }

  return (
    <div className="transcript">
      <div className="transcript__scroll" ref={listRef}>
        {entries.length === 0 ? (
          <p className="empty">The conversation will appear here as you talk.</p>
        ) : (
          <ol className="transcript__list" aria-live="polite" aria-relevant="additions">
            {entries.map((entry) => (
              <TranscriptItem key={entry.id} entry={entry} clientName={clientName} youName={youName} />
            ))}
          </ol>
        )}
      </div>
      <form className="composer" onSubmit={submit}>
        <label htmlFor="composer-input" className="visually-hidden">
          Type a reply
        </label>
        <input
          id="composer-input"
          className="input"
          value={draft}
          maxLength={MAX_UTTERANCE_CHARS}
          placeholder="Type instead of speaking…"
          onChange={(event) => setDraft(event.target.value)}
          disabled={disabled}
          autoComplete="off"
        />
        <button type="submit" className="button button--primary button--icon" disabled={disabled || !draft.trim()} aria-label="Send">
          <SendIcon size={18} />
        </button>
      </form>
    </div>
  )
}
