import { useState, type FormEvent } from 'react'
import { KIND_LABELS, MAX_MATERIAL_CHARS, type Material, type MaterialIn, type MaterialKind } from '../types'
import { MaterialField } from './MaterialField'

interface SharePanelProps {
  clientName: string
  materials: Material[]
  queued: string[]
  disabled: boolean
  onShare(material: MaterialIn): void
}

const KINDS: MaterialKind[] = ['partnership', 'job_posting', 'notes']

export function SharePanel({ clientName, materials, queued, disabled, onShare }: SharePanelProps) {
  const [kind, setKind] = useState<MaterialKind>('partnership')
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const valid = content.trim().length > 0 && content.length <= MAX_MATERIAL_CHARS

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!valid || disabled) return
    const name = title.trim() || KIND_LABELS[kind]
    onShare({ kind, title: title.trim() || null, content })
    setSent(name)
    setTitle('')
    setContent('')
  }

  return (
    <div className="share">
      <form className="share__form" onSubmit={submit}>
        <p className="muted">
          Share a document like you would in a meeting chat. {clientName} reads it right away and reacts once they finish
          their current thought.
        </p>
        <div className="share__row">
          <div className="field">
            <label className="field__label" htmlFor="share-kind">
              Type
            </label>
            <select id="share-kind" className="input" value={kind} onChange={(event) => setKind(event.target.value as MaterialKind)}>
              {KINDS.map((value) => (
                <option key={value} value={value}>
                  {KIND_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor="share-title">
              Title
            </label>
            <input
              id="share-title"
              className="input"
              value={title}
              maxLength={200}
              placeholder="Optional"
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
        </div>
        <MaterialField
          label="Content"
          hint="Paste text or upload a PDF, Word, HTML, or text file."
          placeholder="e.g. A co-selling partnership: 70/30 revenue share, joint webinars, a 3-month pilot…"
          value={content}
          onChange={setContent}
          rows={8}
        />
        <button type="submit" className="button button--primary" disabled={!valid || disabled}>
          Share with {clientName}
        </button>
        {queued.length > 0 && (
          <p className="share__status" role="status">
            Waiting for {clientName} to finish speaking before sharing “{queued.join('”, “')}”.
          </p>
        )}
        {sent && queued.length === 0 && (
          <p className="share__status" role="status">
            Shared “{sent}”.
          </p>
        )}
      </form>

      <section className="share__documents">
        <h3>Documents in this meeting</h3>
        <ul>
          {materials.map((material) => (
            <li key={material.id}>
              <details>
                <summary>
                  <span className="share__doc-title">{material.title}</span>
                  <span className="tag">{material.shared_during_meeting ? 'shared during the meeting' : KIND_LABELS[material.kind]}</span>
                </summary>
                <pre className="share__doc-content">{material.content}</pre>
              </details>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
