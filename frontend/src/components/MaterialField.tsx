import { useId, useRef, useState } from 'react'
import { api } from '../api'
import { MAX_MATERIAL_CHARS } from '../types'
import { UploadIcon } from './icons'

const ACCEPT = '.txt,.md,.markdown,.pdf,.docx,.html,.htm'

interface MaterialFieldProps {
  label: string
  hint: string
  placeholder: string
  value: string
  onChange(value: string): void
  rows?: number
  disabled?: boolean
}

/** A large text field that can also be filled from a PDF, Word, HTML, or text file. */
export function MaterialField({ label, hint, placeholder, value, onChange, rows = 12, disabled }: MaterialFieldProps) {
  const id = useId()
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tooLong = value.length > MAX_MATERIAL_CHARS

  async function handleFile(file: File | undefined) {
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const { text } = await api.extractDocument(file)
      onChange(value.trim() ? `${value.trim()}\n\n${text}` : text)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That file couldn’t be read.')
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <div className="field material-field">
      <div className="field__header">
        <label htmlFor={id} className="field__label">
          {label}
        </label>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => fileInput.current?.click()}
          disabled={disabled || uploading}
        >
          <UploadIcon size={16} />
          {uploading ? 'Reading…' : 'Upload file'}
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          hidden
          onChange={(event) => void handleFile(event.target.files?.[0])}
        />
      </div>
      <p className="field__hint" id={`${id}-hint`}>
        {hint}
      </p>
      <textarea
        id={id}
        className="input textarea"
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={`${id}-hint`}
        aria-invalid={tooLong || undefined}
        disabled={disabled}
        spellCheck
      />
      <div className="field__footer">
        {error ? <span className="field__error">{error}</span> : <span />}
        <span className={tooLong ? 'field__count field__count--over' : 'field__count'}>
          {value.length.toLocaleString()} / {MAX_MATERIAL_CHARS.toLocaleString()}
        </span>
      </div>
    </div>
  )
}
