import type { CaptionSize } from '../lib/preferences'
import type { Caption } from '../meeting/controller'

interface CaptionsProps {
  caption: Caption | null
  clientName: string
  youName: string
  size: CaptionSize
}

/**
 * Live subtitles. For the client, the words already spoken are bright and the rest of the
 * sentence is dimmed; for you, recognized words are bright and the still-changing guess is dimmed.
 */
export function Captions({ caption, clientName, youName, size }: CaptionsProps) {
  return (
    <div className={`captions captions--${size}`} data-testid="captions">
      {caption && (
        <div className="captions__box" data-speaker={caption.speaker}>
          <span className="captions__speaker">{caption.speaker === 'client' ? clientName : youName}</span>
          <p className="captions__text">
            <span className="captions__spoken">{caption.text.slice(0, caption.spokenChars)}</span>
            <span className="captions__pending">{caption.text.slice(caption.spokenChars)}</span>
          </p>
        </div>
      )}
    </div>
  )
}
