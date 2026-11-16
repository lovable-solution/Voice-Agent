import type { ExtractedDocument, Health, SessionCreate, SessionOut } from './types'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

interface ValidationIssue {
  loc?: (string | number)[]
  msg?: string
}

function describeError(body: unknown, status: number): string {
  const detail = (body as { detail?: unknown } | null)?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length) {
    return (detail as ValidationIssue[])
      .map((issue) => {
        const where = (issue.loc ?? []).filter((part) => part !== 'body').join(' › ')
        return where ? `${where}: ${issue.msg}` : String(issue.msg)
      })
      .join('; ')
  }
  if (status === 502 || status === 503 || status === 504) return 'The backend isn’t reachable. Is the FastAPI server running on port 8000?'
  return `Request failed (HTTP ${status}).`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch {
    throw new ApiError('Can’t reach the backend. Is the FastAPI server running?', 0)
  }
  if (response.status === 204) return undefined as T
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new ApiError(describeError(body, response.status), response.status)
  return body as T
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const api = {
  health: () => request<Health>('/api/health'),
  createSession: (body: SessionCreate) => request<SessionOut>('/api/sessions', json(body)),
  getSession: (id: string) => request<SessionOut>(`/api/sessions/${encodeURIComponent(id)}`),
  deleteSession: (id: string) => request<void>(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  extractDocument: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<ExtractedDocument>('/api/documents/extract', { method: 'POST', body: form })
  },
}
