import type { TranscriptEntry } from '../meeting/controller'
import type { SessionOut } from '../types'

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const mm = String(minutes).padStart(hours ? 2 : 1, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}

export function transcriptToMarkdown(
  session: SessionOut,
  entries: TranscriptEntry[],
  startedAt: number | null,
  endedAt: number | null,
): string {
  const { persona, meeting_title } = session.briefing
  const you = session.user_name || 'You'
  const lines = [`# ${meeting_title}`, '']
  lines.push(`- **Client:** ${persona.name}, ${persona.role} at ${persona.company}`)
  if (startedAt) lines.push(`- **Date:** ${new Date(startedAt).toLocaleString()}`)
  if (startedAt && endedAt) lines.push(`- **Duration:** ${formatDuration(endedAt - startedAt)}`)
  lines.push('', '---', '')
  for (const entry of entries) {
    if (entry.kind === 'material') {
      lines.push(`_${you} shared “${entry.text}”${entry.detail ? ` (${entry.detail.toLowerCase()})` : ''}._`, '')
      continue
    }
    const speaker = entry.speaker === 'client' ? persona.name : you
    const text = entry.text || '…'
    lines.push(`**${speaker}:** ${text}${entry.interrupted ? ' —' : ''}${entry.kind === 'typed' ? ' _(typed)_' : ''}`, '')
  }
  return lines.join('\n')
}

export function downloadText(filename: string, text: string, type = 'text/markdown'): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'meeting'
  )
}
