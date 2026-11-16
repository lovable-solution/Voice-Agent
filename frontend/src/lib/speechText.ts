/**
 * Turns model output into text that sounds right when read aloud and reads cleanly
 * as a subtitle. The system prompt already asks for plain speech; this catches slips.
 */

const ACTION = '(?:laugh|chuckl|smil|paus|sigh|nod|grin|lean|clears? (?:my |his |her |their )?throat|shrug|smirk|gestur|sip|wav|tilt)'
const STAGE_DIRECTIONS = [
  new RegExp(`\\*${ACTION}[^*\\n]{0,40}\\*`, 'gi'),
  new RegExp(`\\(${ACTION}[^)\\n]{0,40}\\)`, 'gi'),
  new RegExp(`\\[${ACTION}[^\\]\\n]{0,40}\\]`, 'gi'),
]

export function sanitizeForSpeech(text: string): string {
  let out = text
  for (const pattern of STAGE_DIRECTIONS) out = out.replace(pattern, ' ')
  out = out
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '') // list markers
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1') // links
    .replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2') // italics
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/[*#`]/g, '') // stray markup
    .replace(/\p{Extended_Pictographic}[\u{FE0F}\u{200D}]*/gu, '') // emoji
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
  return out.trim()
}

/** Join two pieces of spoken text with a single space. */
export function joinSpoken(a: string, b: string): string {
  if (!a) return b
  if (!b) return a
  return `${a} ${b}`
}
