// Solomon Mods: the shared design system and switches, one copy in every mod.
// Canonical file: shared/suite.ts. scripts/sync-shared.sh copies it
// into each mod's hooks/ folder (a mod may only import files inside its own folder).
// Edit it here, then run the script; never edit a mod's copy by hand.

import type { EngineInterface } from 'claude-code'

// ---------- Design tokens ----------

/** The one accent: a warm reddish-orange, with a gradient from peach to burnt orange. */
export const ACCENT = '#F0603A'
export const GRADIENT = ['#FF9A6B', '#F0603A', '#C2410C'] as const
/** A colour per helper, category or segment. The accent first, then a colourful spread. */
export const PALETTE = ['#F0603A', '#F59E0B', '#22C55E', '#38BDF8', '#A78BFA', '#F472B6', '#14B8A6', '#FB923C', '#84CC16', '#60A5FA'] as const
export const paletteAt = (i: number) => PALETTE[((i % PALETTE.length) + PALETTE.length) % PALETTE.length] ?? ACCENT
/** The "live" highlight: a cyan glint for the thing happening right now. */
export const LIVE = '#22D3EE'

export const STATUS = {
  good: '#22C55E',
  warn: '#F59E0B',
  bad: '#EF4444',
  info: '#38BDF8',
} as const

/** Neutrals for each mode. Mostly black or mostly white; the accent does the talking. */
export const NEUTRAL = {
  dark: { bg: '#0A0A0B', surface: '#141416', line: '#27272A', text: '#FAFAFA', muted: '#A1A1AA', faint: '#52525B' },
  light: { bg: '#FFFFFF', surface: '#F6F6F7', line: '#E4E4E7', text: '#0A0A0B', muted: '#52525B', faint: '#A1A1AA' },
} as const

/** Text sizes, as the desktop draws them; the terminal has one size. */
export const TYPE = { label: 'caption', meta: 'footnote', body: 'body', title: 'heading', hero: 'title' } as const
/** Spacing steps. Gaps belong on the parent Box, never margins on each child. */
export const SPACE = { tight: 'xs', row: 'sm', block: 'md', section: 'lg' } as const
/** One border style for every card and tile. */
export const RADIUS = 'round'
/** Motion: one tick for spinners, one for shimmer, one for counters. Reduced motion stops SVG animation. */
export const MOTION = { tick: 300, shimmer: 350, count: 120, hold: 20_000 } as const

export const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter','Segoe UI',sans-serif"

/** Each mod's mark, so a glance tells them apart. */
export const MARK: Record<string, string> = {
  'session-keeper': '⧗',
  'mission-control': '◉',
  'helper-desk': '❂',
  'collision-guard': '⛨',
  'prompt-forge': '✦',
  'rule-keeper': '❖',
  'session-ledger': '▤',
  'mod-switchboard': '⏻',
  'higgs-content': '✺',
  'auto-model': '⚡',
  'file-tree': '⌸',
  'design-picker': '◐',
  'idea-shelf': '☰',
  'edit-rewind': '⟲',
  'privacy-shield': '⛉',
  'assumption-radar': '◎',
  'command-guard': '⚠',
  'limit-guard': '◔',
  'voice-guard': '❝',
  'site-check': '✓',
}

/** Every mod in the set, in the order the Switchboard lists them. */
export const MODS = Object.keys(MARK)

// ---------- Colour helpers ----------

/** A colour between `a` and `b`, both #rrggbb; `t` from 0 to 1. */
export function mix(a: string, b: string, t: number): string {
  const at = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  const k = Math.max(0, Math.min(1, t))
  return `#${[0, 1, 2].map(i => Math.round(at(a, i) + (at(b, i) - at(a, i)) * k).toString(16).padStart(2, '0')).join('')}`
}

/** The accent gradient at `t` (0 light, 1 deep). */
export function grad(t: number): string {
  const k = Math.max(0, Math.min(1, t))
  return k < 0.5 ? mix(GRADIENT[0], GRADIENT[1], k * 2) : mix(GRADIENT[1], GRADIENT[2], (k - 0.5) * 2)
}

/** One colour per character of `text`, across the gradient. For short titles only. */
export function gradientColors(text: string): string[] {
  const n = [...text].length
  return [...text].map((_, i) => grad(n > 1 ? i / (n - 1) : 0.5))
}

export type Mode = 'dark' | 'light'
let modeCache: { mode: Mode; at: number } | null = null

/** The person's light or dark theme, read from /config, cached for a minute. Dark when unsure. */
export async function modeOf($: EngineInterface): Promise<Mode> {
  const now = Date.now()
  if (modeCache && now - modeCache.at < 60_000) return modeCache.mode
  let mode: Mode = 'dark'
  try {
    const row = (await $.config.list()).find(r => r.key === 'theme') as { value?: unknown } | undefined
    if (typeof row?.value === 'string' && row.value.toLowerCase().includes('light')) mode = 'light'
  } catch {
    // No config here: dark.
  }
  modeCache = { mode, at: now }
  return mode
}

export const neutral = (mode: Mode) => NEUTRAL[mode]

// ---------- SVG pieces for the desktop ----------

export const xml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

/** The shared <style> head: light and dark ink, and reduced motion. */
export function svgStyle(extra = ''): string {
  const d = NEUTRAL.dark
  const l = NEUTRAL.light
  return `<style>
.ink{fill:${l.text}}.mut{fill:${l.muted}}.trk{fill:${l.line}}.srf{fill:${l.surface}}
@media (prefers-color-scheme: dark){.ink{fill:${d.text}}.mut{fill:${d.muted}}.trk{fill:${d.line}}.srf{fill:${d.surface}}}
.shim{animation:shim 2.4s linear infinite}@keyframes shim{from{transform:translateX(-80px)}to{transform:translateX(var(--w,400px))}}
.pulse{animation:pulse 1.6s ease-in-out infinite}@keyframes pulse{0%,100%{opacity:.25}50%{opacity:.6}}
${extra}
@media (prefers-reduced-motion: reduce){.shim,.pulse{animation:none}}
</style>`
}

export const gradDefs = (id: string) =>
  `<linearGradient id="${id}" x1="0" x2="1"><stop offset="0" stop-color="${GRADIENT[0]}"/><stop offset=".55" stop-color="${GRADIENT[1]}"/><stop offset="1" stop-color="${GRADIENT[2]}"/></linearGradient>`

/** A rounded progress track, gradient fill, optional glint while live. Desktop only. */
export function barSvg(ratio: number, W: number, H = 8, opts: { live?: boolean; id?: string; color?: string } = {}): string {
  const id = opts.id ?? 'sb'
  const fill = Math.round(W * Math.max(0, Math.min(1, ratio)))
  const paint = opts.color ?? `url(#${id}-g)`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svgStyle(`.shim{--w:${fill + 80}px}`)}
<defs>${gradDefs(`${id}-g`)}<linearGradient id="${id}-s" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<clipPath id="${id}-c"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath><clipPath id="${id}-f"><rect width="${fill}" height="${H}"/></clipPath></defs>
<g clip-path="url(#${id}-c)"><rect class="trk" width="${W}" height="${H}"/>${fill > 0 ? `<rect width="${fill}" height="${H}" fill="${paint}"/>` : ''}
${opts.live && fill > 0 ? `<g clip-path="url(#${id}-f)"><rect class="shim" width="80" height="${H}" fill="url(#${id}-s)"/></g>` : ''}</g></svg>`
}

// ---------- Terminal pieces ----------

/** Cells of a terminal bar: filled cells each with a gradient colour, the rest as a dim track. */
export function barCells(ratio: number, w: number): { fill: string[]; rest: number } {
  const n = Math.max(0, Math.min(w, Math.round(w * Math.max(0, Math.min(1, ratio)))))
  return { fill: Array.from({ length: n }, (_, i) => grad(n > 1 ? i / (n - 1) : 1)), rest: w - n }
}

// ---------- Text helpers ----------

export const cut = (t: string, n: number) => (n <= 0 ? '' : t.length > n ? `${t.slice(0, Math.max(0, n - 1))}…` : t)
export const oneLine = (t: string) => t.replace(/\s+/g, ' ').trim()
export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`

export function clockTime(ms: number) {
  const t = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = String(t % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`
}

export function tokenText(n: number) {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** "3h 05m" / "42m" */
export function duration(minutes: number) {
  const m = Math.max(0, Math.round(minutes))
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

export const money = (usd: number) => `$${usd < 10 ? usd.toFixed(2) : Math.round(usd).toLocaleString('en-US')}`

// ---------- Home, logs ----------

export function homeOf($: EngineInterface) {
  const root = $.plugin.root
  // Installed copies live under ~/.claude/; a mod read from a folder (dev mode, a folder
  // marketplace) lives anywhere, so fall back to the user folder its path starts with.
  if (root.includes('/.claude/')) return root.split('/.claude/')[0] ?? ''
  return /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)/.exec(root)?.[1] ?? root
}

/** Appends one line to ~/.claude/mods-logs/<mod>.log, kept to the last 50 KB. Never throws. */
export async function log($: EngineInterface, mod: string, line: string) {
  try {
    const dir = `${homeOf($)}/.claude/mods-logs`
    const path = `${dir}/${mod}.log`
    let old = ''
    if (await $.fs.exists(path).catch(() => false)) old = String(await $.fs.read(path))
    else await $.process.run(['mkdir', '-p', dir])
    await $.fs.write(path, `${old}${new Date(await $.clock.now()).toISOString()} ${line}\n`.slice(-50_000))
  } catch {
    // Logging must never break the session.
  }
}

// ---------- Switches: one file every chat reads ----------
// ~/.claude/mods/switches.json, read by every mod in every chat:
//   "<mod>": false              the mod is off in every chat
//   "<mod>:hidden": true        on, but draws nothing (no pane opens by itself, no band)
//   "<mod>:<part>": false       one part of the mod is off (Mod Switchboard lists the parts)

export type Switches = Record<string, unknown>
let switchCache: { at: number; json: Switches } | null = null

export function switchesPath($: EngineInterface) {
  return `${homeOf($)}/.claude/mods/switches.json`
}

/** The switch file, re-read at most every 3 seconds. A missing or broken file is all-on. */
export async function readSwitches($: EngineInterface, fresh = false): Promise<Switches> {
  const now = Date.now()
  if (!fresh && switchCache && now - switchCache.at < 3000) return switchCache.json
  let json: Switches = {}
  try {
    const path = switchesPath($)
    if (await $.fs.exists(path)) {
      const v = JSON.parse(String(await $.fs.read(path))) as unknown
      if (v && typeof v === 'object' && !Array.isArray(v)) json = v as Switches
    }
  } catch {
    json = {}
  }
  switchCache = { at: now, json }
  return json
}

export async function writeSwitches($: EngineInterface, json: Switches) {
  await $.process.run(['mkdir', '-p', `${homeOf($)}/.claude/mods`])
  await $.fs.write(switchesPath($), `${JSON.stringify(json, null, 2)}\n`)
  switchCache = { at: Date.now(), json }
}

export const isOn = (json: Switches, mod: string) => json[mod] !== false
export const isHidden = (json: Switches, mod: string) => json[`${mod}:hidden`] === true
/** A part is on unless switched off, or unless it defaults off and was never switched on. */
export const isPartOn = (json: Switches, mod: string, part: string, byDefault = true) => {
  const v = json[`${mod}:${part}`]
  return v === undefined ? byDefault : v !== false
}

/** One call for a hook: is the mod on, and is this part of it on? */
export async function partOn($: EngineInterface, mod: string, part?: string, byDefault = true) {
  const json = await readSwitches($)
  if (!isOn(json, mod)) return false
  return part ? isPartOn(json, mod, part, byDefault) : true
}

/** An open request another chat's Mod Switchboard left for this chat: true once, then gone. */
export async function takeOpenRequest($: EngineInterface, mod: string, sessionId: string) {
  if (!sessionId) return false
  const path = `${homeOf($)}/.claude/mods/.open-${mod}-${sessionId}`
  try {
    if (!(await $.fs.exists(path))) return false
    await $.process.run(['rm', '-f', path])
    return true
  } catch {
    return false
  }
}

// ---------- Secrets: one scrubber for every mod that saves or shows text ----------
// Written for this suite (not copied from any other mod). Each pattern names a kind of key
// so the replacement says what was removed without showing any of it.
export const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'OpenAI key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/g },
  { kind: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'Google key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'AWS key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Stripe key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { kind: 'bearer token', re: /(?<=Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: 'password', re: /(?<=\b(?:password|passwd|pwd|secret|api[_-]?key|token)\s*[:=]\s*["']?)[^\s"']{8,}/gi },
]

/** The text with every secret-shaped run replaced by "<Anthropic key removed>" and so on. */
export function redactSecrets(text: string): { text: string; found: string[] } {
  const found: string[] = []
  let out = text
  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      found.push(kind)
      return `<${kind} removed>`
    })
  }
  return { text: out, found }
}

// ---------- Room to breathe on graphical surfaces ----------
// A desktop draws each Button as a native button taller than one text line, so
// rows laid out a line apart overlap there. roomy() copies a band or pane tree and,
// on desktop and phones only, puts a gap between rows (a bigger one where a row
// holds buttons), a gap between buttons, and space above and below the whole tree.
// The terminal and VS Code draw in cells and are returned untouched.

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown } & Record<string, unknown>

function holdsButton(n: unknown, depth = 0): boolean {
  if (!n || typeof n !== 'object' || depth > 3) return false
  if (Array.isArray(n)) return n.some(c => holdsButton(c, depth))
  const node = n as Node
  if (node.type === 'Button') return true
  return node.type === 'Box' && holdsButton(node.children, depth + 1)
}

export function roomy<T>(tree: T, surface: unknown): T {
  if (surface !== 'desktop' && surface !== 'mobile') return tree
  const walk = (n: unknown, top: boolean): unknown => {
    if (!n || typeof n !== 'object') return n
    if (Array.isArray(n)) return n.map(c => walk(c, top))
    const node = n as Node
    // Another plugin's or the engine's own drawing (stamped with `part`) is left as it is.
    if (node.type !== 'Box' || node.part !== undefined) return n
    const props: Record<string, unknown> = { ...(node.props ?? {}) }
    const kids = Array.isArray(node.children) ? node.children : node.children === undefined ? [] : [node.children]
    const column = props.flexDirection === 'column' || props.flexDirection === 'column-reverse'
    if (props.gap === undefined) {
      if (column && props.rowGap === undefined && kids.length > 1) props.rowGap = kids.some(k => holdsButton(k)) ? 'md' : 'sm'
      if (!column && props.columnGap === undefined && kids.some(k => holdsButton(k))) props.columnGap = 'sm'
    }
    if (!column && props.alignItems === undefined && kids.some(k => holdsButton(k))) props.alignItems = 'center'
    if (top && props.paddingY === undefined && props.paddingTop === undefined && props.padding === undefined) {
      props.paddingTop = 'sm'
      props.paddingBottom = 'xs'
    }
    return { ...node, props, children: node.children === undefined ? undefined : walk(node.children, false) }
  }
  return walk(tree, true) as T
}

// ---------- The Claude crab: a pixel mascot that hops, blinks and waves (desktop SVG, terminal glyph) ----------

type Px = [x: number, y: number]
const crabSpan = (y: number, from: number, to: number): Px[] => Array.from({ length: to - from + 1 }, (_, i) => [from + i, y] as Px)

/** One frame on a 16 by 12 grid. 0 stands; 1 hops up a pixel with its legs moved; 2 blinks; 3 raises both claws. */
function crabFrame(frame: number): { body: Px[]; eyes: Px[] } {
  const dy = frame === 1 ? 0 : 1
  const clawsUp = frame === 3
  const body: Px[] = [
    ...crabSpan(1, 3, 12),
    ...crabSpan(2, 3, 12),
    ...crabSpan(3, 3, 12),
    ...(clawsUp ? crabSpan(4, 3, 12) : crabSpan(4, 1, 14)),
    ...(clawsUp ? crabSpan(5, 3, 12) : crabSpan(5, 1, 14)),
    ...crabSpan(6, 3, 12),
    ...crabSpan(7, 3, 12),
  ]
  if (clawsUp) body.push([1, 2], [2, 2], [1, 3], [2, 3], [13, 2], [14, 2], [13, 3], [14, 3])
  const legs = frame % 2 === 1 ? [3, 5, 10, 12] : [4, 6, 9, 11]
  for (const x of legs) body.push([x, 8], [x, 9])
  const eyes: Px[] = frame === 2 ? [[5, 4], [10, 4]] : [[5, 3], [5, 4], [10, 3], [10, 4]]
  const move = (p: Px): Px => [p[0], p[1] + dy]
  return { body: body.map(move), eyes: eyes.map(move) }
}

const CRAB_INK = '#2b1d16'

/** The pixels of one frame, with a one-pixel outline so every body colour reads on light and dark. */
function crabRects(frame: number, color: string): string {
  const { body, eyes } = crabFrame(frame)
  const has = new Set(body.map(([x, y]) => `${x},${y}`))
  const ring = new Set<string>()
  for (const [x, y] of body) {
    for (const [ax, ay] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as Px[]) {
      const k = `${ax},${ay}`
      if (!has.has(k)) ring.add(k)
    }
  }
  const rect = (x: number, y: number, c: string) => `<rect x="${x + 1}" y="${y + 1}" width="1" height="1" fill="${c}"/>`
  return [
    ...[...ring].map(k => {
      const [x, y] = k.split(',').map(Number)
      return rect(x ?? 0, y ?? 0, CRAB_INK)
    }),
    ...body.map(([x, y]) => rect(x, y, color)),
    ...eyes.map(([x, y]) => rect(x, y, CRAB_INK)),
  ].join('')
}

/** The crab as an SVG: it hops, blinks and waves its claws on a loop. `color` tints its body. Height is 13/18 of `size`. */
export function crabSvg(size = 28, color: string = ACCENT, opts: { still?: boolean; id?: string } = {}): string {
  const id = opts.id ?? 'cr'
  const h = Math.round((size * 13) / 18)
  const head = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${h}" viewBox="0 0 18 13" shape-rendering="crispEdges">`
  if (opts.still) return `${head}${crabRects(0, color)}</svg>`
  const frames = [0, 1, 2, 3].map(f => `<g class="${id}-f ${id}-f${f}">${crabRects(f, color)}</g>`).join('')
  const css =
    `.${id}-f{opacity:0;animation:${id}-a 1.6s step-end infinite}` +
    [1, 2, 3].map(f => `.${id}-f${f}{animation-delay:${f * 0.4}s}`).join('') +
    `@keyframes ${id}-a{0%{opacity:1}25%{opacity:0}100%{opacity:0}}` +
    `@media (prefers-reduced-motion: reduce){.${id}-f{animation:none}.${id}-f0{opacity:1}}`
  return `${head}<style>${css}</style>${frames}</svg>`
}

/** The terminal's crab. */
export const crabGlyph = (_tick = 0) => '🦀'

// ---------- Small building blocks shared by panes ----------

/** A pill: a short label on a tinted chip, as an SVG for the desktop. */
export function pillSvg(text: string, color: string, h = 18): string {
  const w = Math.max(28, Math.round(text.length * 6.4) + 14)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="${h / 2}" fill="${color}" opacity=".18"/><text x="${w / 2}" y="${h / 2 + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" fill="${color}">${xml(text)}</text></svg>`
}

/** Today as yyyy-mm-dd in local time. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A JSON file under ~/.claude/mods/, read safely: the fallback when missing or broken. */
export async function readJson<T>($: EngineInterface, name: string, fallback: T): Promise<T> {
  try {
    const path = `${homeOf($)}/.claude/mods/${name}`
    if (!(await $.fs.exists(path))) return fallback
    return JSON.parse(String(await $.fs.read(path))) as T
  } catch {
    return fallback
  }
}

/** Writes a JSON file under ~/.claude/mods/, making the folder first. */
export async function writeJson($: EngineInterface, name: string, value: unknown) {
  const dir = `${homeOf($)}/.claude/mods`
  const path = `${dir}/${name}`
  const parent = path.slice(0, path.lastIndexOf('/'))
  await $.process.run(['mkdir', '-p', parent])
  await $.fs.write(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** The Obsidian vault the person set in ~/.claude/mods/settings.json ("vault"), or '' when none. */
export async function vaultPath($: EngineInterface): Promise<string> {
  const s = await readJson<{ vault?: string }>($, 'settings.json', {})
  const v = (s.vault ?? '').trim()
  if (!v) return ''
  return v.startsWith('~/') ? `${homeOf($)}${v.slice(1)}` : v
}

/** Appends text to a vault note (made with a heading if new). Returns the path, or '' with no vault. */
export async function appendToVault($: EngineInterface, relPath: string, heading: string, text: string): Promise<string> {
  const vault = await vaultPath($)
  if (!vault) return ''
  const path = `${vault}/${relPath}`
  await $.process.run(['mkdir', '-p', path.slice(0, path.lastIndexOf('/'))])
  let old = ''
  if (await $.fs.exists(path).catch(() => false)) old = String(await $.fs.read(path))
  else old = `# ${heading}\n\n`
  await $.fs.write(path, `${old.replace(/\n*$/, '\n')}${text}\n`)
  return path
}
