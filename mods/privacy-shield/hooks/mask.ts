// Privacy Shield's masking rules (Solomon Mods, MIT). Written from scratch for this mod.
// Hides emails, phone numbers, money amounts and labelled names while you share your screen.
// Careful by design: years, versions, token counts (182k), file paths and links stay visible.
// Each hidden piece becomes a bar of the same length, so lines keep their shape.

export type Kind = 'email' | 'phone' | 'amount' | 'name'

/** Solid bar for hidden text, and the lighter one used while the shield fades in. */
export const BAR = '▒'
export const FADE = '░'

type Hit = { start: number; end: number; kind: Kind }

const EMAIL = /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])(?!:[\w~/])/g
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi
const PATH = /(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+/g
const CURRENCY = /(?:[$£€₹¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion|thousand))?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|GBP|EUR|AUD|CAD|INR|dollars|pounds|euros)\b)/gi
// Phone: an optional + or bracket, then 9 to 15 digits split by spaces, dots, dashes or brackets.
const PHONE = /(?<![\w./-])[+(]?\d[\d\s().-]{7,20}\d(?![\w/-])/g
// Names only where a label says it is a name: "Name: Jane Smith", "From: Jane Smith <...>".
const LABELS = ['name', 'full name', 'client', 'customer', 'contact', 'from', 'to', 'attendee', 'patient']
const LABELLED_NAME = new RegExp(
  `\\b(?:${LABELS.map(l => `[${l[0]!.toUpperCase()}${l[0]}]${l.slice(1)}`).join('|')})\\s*[:=]\\s*((?:[A-Z][a-z'’-]+)(?:[ \\t]+[A-Z][a-z'’-]+){0,3})`,
  'g',
)

const NAME_KEYS = /^(?:full_?name|first_?name|last_?name|display_?name|given_?name|family_?name|sender_?name|contact_?name|author_?name|owner_?name|client_?name|customer_?name)$/i

function digitsIn(s: string) {
  return (s.match(/\d/g) ?? []).length
}

function looksLikeDateOrVersion(s: string) {
  return /^\d{4}[-./]\d{1,2}[-./]\d{1,2}$/.test(s.trim()) || /^v?\d+(?:\.\d+){1,3}$/.test(s.trim())
}

function collect(text: string, re: RegExp, kind: Kind, out: Hit[], group = 0, keep?: (s: string) => boolean) {
  re.lastIndex = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const s = m[group]
    if (!s) continue
    if (keep && !keep(s)) continue
    const start = m.index + (group ? m[0].indexOf(s) : 0)
    out.push({ start, end: start + s.length, kind })
  }
}

/** The spans to hide, sorted, with overlaps removed and anything inside a link or path kept. */
export function findHits(text: string): Hit[] {
  const safe: Hit[] = []
  collect(text, LINK, 'email', safe)
  collect(text, PATH, 'email', safe)
  const inSafe = (h: Hit) => safe.some(s => h.start >= s.start && h.end <= s.end)
  const hits: Hit[] = []
  collect(text, EMAIL, 'email', hits)
  collect(text, CURRENCY, 'amount', hits)
  collect(text, PHONE, 'phone', hits, 0, s => {
    const d = digitsIn(s)
    return d >= 9 && d <= 15 && !looksLikeDateOrVersion(s)
  })
  collect(text, LABELLED_NAME, 'name', hits, 1)
  const kept = hits.filter(h => h.kind === 'email' || !inSafe(h)).sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Hit[] = []
  for (const h of kept) {
    const last = out[out.length - 1]
    if (last && h.start < last.end) continue
    out.push(h)
  }
  return out
}

/** A bar as long as the text it hides; spaces stay spaces so wrapping does not change. */
export function bar(hidden: string, glyph = BAR) {
  return hidden.replace(/\S/g, glyph)
}

export function mask(text: string, glyph = BAR): string {
  if (!text) return text
  const hits = findHits(text)
  if (hits.length === 0) return text
  let out = ''
  let at = 0
  for (const h of hits) {
    out += text.slice(at, h.start) + bar(text.slice(h.start, h.end), glyph)
    at = h.end
  }
  return out + text.slice(at)
}

/** Masks every string inside a value (tool output, JSON), and whole values under name-like keys. */
export function maskDeep<T>(value: T, glyph = BAR, depth = 0): T {
  if (depth > 12) return value
  if (typeof value === 'string') return mask(value, glyph) as T
  if (Array.isArray(value)) return value.map(v => maskDeep(v, glyph, depth + 1)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = typeof v === 'string' && NAME_KEYS.test(k) ? bar(v, glyph) : maskDeep(v, glyph, depth + 1)
    }
    return out as T
  }
  return value
}
