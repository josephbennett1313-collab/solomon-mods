// Design Picker's style list, ranking and preview drawing. No engine calls here.

import { ACCENT, GRADIENT, oneLine } from './suite'

export type Style = {
  id: string
  name: string
  keywords: string
  primary: string
  secondary: string
  effects: string
  bestFor: string
  avoid: string
  prompt: string
  css: string
  checklist: string
  vars: string
  mode: string
}

// ---------- The style list ----------

/** A CSV parser for quoted fields, doubled quotes and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      if (row.some(v => v !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  row.push(cell)
  if (row.some(v => v !== '')) rows.push(row)
  return rows
}

/** The active styles of a UI UX Pro Max styles.csv. */
export function stylesFromCsv(text: string): Style[] {
  const [head, ...rows] = parseCsv(text)
  if (!head) return []
  const col = (name: string) => head.findIndex(h => h.trim().toLowerCase().startsWith(name.toLowerCase()))
  const at = (r: string[], name: string) => {
    const k = col(name)
    return k >= 0 ? (r[k] ?? '').trim() : ''
  }
  return rows
    .filter(r => {
      const status = at(r, 'Status').toLowerCase()
      return !status || status === 'active'
    })
    .map(r => ({
      id: at(r, 'Style ID') || at(r, 'Style Category').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: at(r, 'Style Category'),
      keywords: at(r, 'Keywords'),
      primary: at(r, 'Primary Colors'),
      secondary: at(r, 'Secondary Colors'),
      effects: at(r, 'Effects'),
      bestFor: at(r, 'Best For'),
      avoid: at(r, 'Do Not Use'),
      prompt: at(r, 'AI Prompt'),
      css: at(r, 'CSS/Technical'),
      checklist: at(r, 'Implementation Checklist'),
      vars: at(r, 'Design System Variables'),
      mode: at(r, 'Preferred Mode'),
    }))
    .filter(s => s.name)
}

/** Used only when the skill's file can't be read. Written for this mod. */
export const FALLBACK: Style[] = [
  { id: 'minimal', name: 'Minimal', keywords: 'clean, white space, grid, sans-serif, high contrast', primary: 'Black #000000, White #FFFFFF', secondary: 'Grey #8A8A8A, one accent #7C3AED', effects: 'Short fades, no heavy shadows', bestFor: 'Business sites, dashboards, tools', avoid: 'Playful brands', prompt: 'Minimal layout, generous white space, one accent colour, clear type scale', css: 'grid, gap, font-weight 400-700', checklist: '☐ One accent colour, ☐ Clear type scale, ☐ Contrast 4.5:1', vars: '--border-radius: 4px, --shadow: none', mode: 'auto' },
  { id: 'glass', name: 'Glass', keywords: 'frosted, translucent, blur, gradient, layered', primary: 'White #FFFFFF, Violet #8B5CF6', secondary: 'Cyan #22D3EE, Navy #0F172A', effects: 'Backdrop blur, soft borders', bestFor: 'Product pages, modern apps', avoid: 'Text-heavy pages', prompt: 'Frosted glass cards over a vivid gradient, thin light borders', css: 'backdrop-filter: blur(16px)', checklist: '☐ Text contrast on glass, ☐ Blur 10-20px', vars: '--border-radius: 16px, --glass-opacity: 0.15', mode: 'auto' },
  { id: 'brutal', name: 'Brutalist', keywords: 'raw, bold, thick borders, hard shadows, loud', primary: 'Black #000000, Yellow #FDE047', secondary: 'White #FFFFFF, Red #EF4444', effects: 'Hard offset shadows, no easing', bestFor: 'Creative studios, launches', avoid: 'Banks, health', prompt: 'Thick black borders, hard offset shadows, loud flat colour', css: 'border: 3px solid #000; box-shadow: 6px 6px 0 #000', checklist: '☐ Borders consistent, ☐ Shadows hard', vars: '--border-radius: 0px', mode: 'auto' },
  { id: 'oled', name: 'Dark (OLED)', keywords: 'dark, black, neon accent, low glare', primary: 'Black #000000, Charcoal #121212', secondary: 'Green #22C55E, Cyan #22D3EE', effects: 'Glow on focus', bestFor: 'Dev tools, media, night use', avoid: 'Print-like reading', prompt: 'True black background, one neon accent, soft glow on focus', css: 'background: #000', checklist: '☐ Contrast on black, ☐ No pure white walls of text', vars: '--border-radius: 8px', mode: 'dark' },
  { id: 'clay', name: 'Clay', keywords: 'soft, rounded, puffy, pastel, playful, 3D', primary: 'Peach #FDBA74, Lilac #C4B5FD', secondary: 'Mint #86EFAC, Cream #FFF7ED', effects: 'Inner and outer soft shadows', bestFor: 'Kids, wellness, friendly apps', avoid: 'Data-dense tools', prompt: 'Puffy rounded clay shapes, pastel colours, soft double shadows', css: 'border-radius: 24px', checklist: '☐ Radius 20-28px, ☐ Pastels checked for contrast', vars: '--border-radius: 24px', mode: 'auto' },
  { id: 'aurora', name: 'Aurora', keywords: 'gradient, aurora, glow, flowing colour, vibrant', primary: 'Violet #7C3AED, Teal #14B8A6', secondary: 'Pink #EC4899, Navy #0B1020', effects: 'Slow moving gradients', bestFor: 'AI products, launches, hero sections', avoid: 'Forms-heavy apps', prompt: 'Soft aurora gradients behind clean content, gentle glow', css: 'radial-gradient layers', checklist: '☐ Motion respects reduced-motion, ☐ Text readable over gradient', vars: '--border-radius: 12px', mode: 'dark' },
]

// ---------- Ranking ----------

const STOP = new Set('a an and the for with to of in on my our your app site page website make build design want need like that this it is are be some new'.split(' '))
const words = (t: string) => t.toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length > 2 && !STOP.has(w)) ?? []

/** Styles in the order they suit `query`; the list's own order when there is no query. */
export function rank(styles: Style[], query: string): Style[] {
  const want = words(query)
  if (!want.length) return styles
  const has = (set: Set<string>, w: string) => set.has(w) || set.has(`${w}s`) || (w.endsWith('s') && set.has(w.slice(0, -1)))
  const score = (s: Style) => {
    const name = new Set(words(s.name))
    const fits = new Set(words(`${s.keywords} ${s.bestFor}`))
    const avoid = new Set(words(s.avoid))
    let n = 0
    for (const w of want) {
      if (has(name, w)) n += 4
      if (has(fits, w)) n += 2
      if (has(avoid, w)) n -= 3
    }
    return n
  }
  return styles
    .map((s, k) => ({ s, k, n: score(s) }))
    .sort((a, b) => b.n - a.n || a.k - b.k)
    .map(x => x.s)
}

// ---------- Drawing a preview ----------

const hexes = (t: string) => t.match(/#[0-9a-fA-F]{6}\b/g) ?? []
const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255
}
const sat = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return (Math.max(...c) - Math.min(...c)) / 255
}

/** The few tokens a preview needs, worked out from the style's own text. */
export function tokensOf(s: Style) {
  const all = [...hexes(s.primary), ...hexes(s.secondary)]
  const text = `${s.name} ${s.keywords} ${s.effects}`.toLowerCase()
  const darkName = /dark|oled|cyber|hud|sci-fi|neon|night/.test(text)
  const dark = s.mode === 'dark' || darkName
  const colourful = [...all].sort((a, b) => sat(b) - sat(a))
  const accent = colourful.find(h => sat(h) > 0.25) ?? ACCENT
  const accent2 = colourful.find(h => h !== accent && sat(h) > 0.25) ?? GRADIENT[0]
  const lights = all.filter(h => lum(h) > 0.85)
  const darks = all.filter(h => lum(h) < 0.12)
  const bg = dark ? (darks[0] ?? '#0B0B0F') : (lights[0] ?? '#FFFFFF')
  const ink = dark ? '#F4F4F5' : (darks[0] ?? '#111114')
  const radiusVar = /--border-radius:\s*(\d+)/.exec(s.vars)
  const brutal = /brutal|raw|anti-polish/.test(text)
  const soft = /clay|neumorph|soft|puffy|organic/.test(text)
  const radius = radiusVar ? Math.min(20, Number(radiusVar[1]) / 1.5) : brutal ? 0 : soft ? 12 : 5
  return {
    bg,
    ink,
    accent,
    accent2,
    radius,
    dark,
    brutal,
    soft,
    glass: /glass|frost|translucent|liquid/.test(text),
    gradient: /gradient|aurora|vibrant|glow|liquid|holograph/.test(text),
    swatches: [...new Set(all)].slice(0, 6),
  }
}

/** A small mock-up page drawn in the style: header, hero, button and two cards. */
export function previewSvg(s: Style, W = 168, H = 104): string {
  const t = tokensOf(s)
  const id = `dp-${s.id.replace(/[^a-z0-9-]/gi, '')}`
  const r = t.radius
  const line = t.dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.10)'
  const stroke = t.brutal ? ` stroke="${t.ink}" stroke-width="2"` : ''
  const hard = (x: number, y: number, w: number, h: number) => (t.brutal ? `<rect x="${x + 3}" y="${y + 3}" width="${w}" height="${h}" fill="${t.ink}"/>` : '')
  const card = (x: number, y: number, w: number, h: number) => {
    if (t.glass) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="#fff" fill-opacity=".16" stroke="#fff" stroke-opacity=".35"/>`
    if (t.soft) return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${t.bg}" filter="url(#${id}-soft)"/>`
    return `${hard(x, y, w, h)}<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${t.dark ? '#ffffff' : '#000000'}" fill-opacity="${t.dark ? '.06' : '.035'}"${stroke || ` stroke="${line}"`}/>`
  }
  const bgFill = t.gradient || t.glass ? `url(#${id}-bg)` : t.bg
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="${id}-bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.dark ? t.bg : t.accent2}" stop-opacity="${t.dark ? 1 : 0.55}"/><stop offset=".6" stop-color="${t.accent}" stop-opacity="${t.dark ? 0.55 : 0.75}"/><stop offset="1" stop-color="${t.dark ? '#000' : t.bg}"/></linearGradient>
<linearGradient id="${id}-btn" x1="0" x2="1"><stop offset="0" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.gradient ? t.accent2 : t.accent}"/></linearGradient>
<filter id="${id}-soft" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="2" dy="2" stdDeviation="2" flood-color="#000" flood-opacity=".18"/><feDropShadow dx="-2" dy="-2" stdDeviation="2" flood-color="#fff" flood-opacity=".8"/></filter>
<clipPath id="${id}-clip"><rect width="${W}" height="${H}" rx="8"/></clipPath>
</defs>
<g clip-path="url(#${id}-clip)">
<rect width="${W}" height="${H}" fill="${t.bg}"/><rect width="${W}" height="${H}" fill="${bgFill}"/>
<rect x="0" y="0" width="${W}" height="14" fill="${t.dark ? '#000' : '#fff'}" fill-opacity="${t.glass ? '.2' : '.55'}"/>
<circle cx="9" cy="7" r="2" fill="${t.ink}" fill-opacity=".35"/><circle cx="16" cy="7" r="2" fill="${t.ink}" fill-opacity=".35"/>
<rect x="${W - 46}" y="5" width="16" height="4" rx="2" fill="${t.ink}" fill-opacity=".35"/><rect x="${W - 26}" y="5" width="16" height="4" rx="2" fill="${t.ink}" fill-opacity=".35"/>
<rect x="12" y="24" width="${W * 0.55}" height="9" rx="${Math.min(r, 3)}" fill="${t.ink}"/>
<rect x="12" y="38" width="${W * 0.42}" height="4" rx="2" fill="${t.ink}" fill-opacity=".45"/>
${hard(12, 49, 42, 13)}<rect x="12" y="49" width="42" height="13" rx="${r}" fill="url(#${id}-btn)"${stroke}/>
${card(12, 70, (W - 32) / 2, 24)}${card(20 + (W - 32) / 2, 70, (W - 32) / 2, 24)}
<rect x="${W * 0.68}" y="22" width="${W * 0.24}" height="40" rx="${r}" fill="${t.accent2}" fill-opacity="${t.glass ? '.35' : '.9'}"${stroke}/>
</g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="8" fill="none" stroke="${line}"/>
</svg>`
}

// ---------- The pick ----------

/** What goes to Claude when a style is picked. */
export function briefOf(s: Style, query: string, motion: 'none' | 'subtle' | '3d' = 'none', skills: string[] = []): string {
  const lines = [
    `Use the "${s.name}" design style${query ? ` for: ${oneLine(query)}` : ''}.`,
    s.prompt && `Direction: ${oneLine(s.prompt)}`,
    s.keywords && `Keywords: ${oneLine(s.keywords)}`,
    (s.primary || s.secondary) && `Colours: ${oneLine([s.primary, s.secondary].filter(Boolean).join('; '))}`,
    s.effects && `Effects and motion: ${oneLine(s.effects)}`,
    s.vars && `Design tokens: ${oneLine(s.vars)}`,
    s.css && `CSS notes: ${oneLine(s.css)}`,
    s.checklist && `Check before you finish: ${oneLine(s.checklist)}`,
    motion === 'subtle' && 'Motion: subtle and quick (150 to 250 ms ease-out on hover, focus and entry). Respect prefers-reduced-motion.',
    motion === '3d' &&
      'Motion: 3D. Give the hero real depth: CSS perspective with translateZ layers and preserve-3d, cards that tilt toward the pointer, parallax on scroll, and a three.js object where one fits. Keep 60 fps (transform and opacity only), and turn it all off under prefers-reduced-motion.',
    'Build it with current web methods: CSS container queries, scroll-driven animations (animation-timeline), the View Transitions API between screens, color-mix and oklch colours, fluid type with clamp, and :has() for state. Ship semantic HTML with visible focus states.',
    skills.length ? `Use these installed design skills while you build: ${skills.join(', ')}.` : '',
    '(Picked in Design Picker; the style comes from the UI UX Pro Max list.)',
  ]
  return lines.filter(Boolean).join('\n')
}


/** Adds a gentle animation to a preview drawing: a float for subtle, a 3D-style tilt and drift for 3d. */
export function withMotion(svg: string, motion: 'none' | 'subtle' | '3d'): string {
  if (motion === 'none') return svg
  const css =
    motion === 'subtle'
      ? '.mv{animation:fl 3s ease-in-out infinite;transform-origin:50% 50%}@keyframes fl{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}'
      : '.mv{animation:tl 5s ease-in-out infinite;transform-origin:50% 55%;transform-box:fill-box;filter:drop-shadow(0 6px 6px rgba(0,0,0,.35))}@keyframes tl{0%,100%{transform:perspective(600px) rotateY(0) rotateX(0)}25%{transform:perspective(600px) rotateY(-9deg) rotateX(3deg) scale(1.02)}75%{transform:perspective(600px) rotateY(9deg) rotateX(-3deg) scale(1.02)}}'
  const open = svg.indexOf('>') + 1
  const close = svg.lastIndexOf('</svg>')
  return `${svg.slice(0, open)}<style>${css}@media (prefers-reduced-motion: reduce){.mv{animation:none}}</style><g class="mv">${svg.slice(open, close)}</g></svg>`
}

/** Asks Claude for a real, self-contained HTML mock-up of the style, shown as an Artifact. */
export function mockupPrompt(s: Style, query: string, motion: 'none' | 'subtle' | '3d', skills: string[]): string {
  return [
    `Make a visual mock-up of the "${s.name}" style${query ? ` for: ${oneLine(query)}` : ''} before building anything.`,
    'One self-contained HTML page: every style inline in a <style> block, images as inline SVG or data URIs, no external scripts except from cdnjs. Show the key screen with real-looking copy, a header, the hero, one content section and a footer.',
    'Publish it as an Artifact so I can look at it, then stop and ask whether to build from it, change it, or try another style.',
    '',
    briefOf(s, query, motion, skills),
  ].join('\n')
}
