export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  const first = parts[0][0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : ''
  return (first + last).toUpperCase()
}

interface AvatarProps {
  name: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  tone?: 'client' | 'you'
}

export function Avatar({ name, size = 'md', tone = 'client' }: AvatarProps) {
  return (
    <span className={`avatar avatar--${size} avatar--${tone}`} aria-hidden="true">
      {initials(name)}
    </span>
  )
}
