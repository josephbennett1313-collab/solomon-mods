// Session Ledger's Report (after Tristen O'Brien's idea): tasks done, hours saved and their dollar
// value, by day, week, month and year, across every chat. Each chat keeps its own log file, so two
// chats never write the same file:  ~/.claude/mods-state/ledger/<YYYY-MM>/<session>.jsonl
//
// One line per finished job (a prompt Claude worked on with at least one tool):
//   { "t": <ms>, "minutes": 14, "calls": 9, "steps": 3, "title": "Fix the pricing page" }
// Minutes are Agent Narrator's per-step estimates of how long a person would take
// (narrate.ts), summed for the steps that worked. They are estimates, said so on screen.

import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Job, Period, Totals } from '../types'
import { narrate } from './narrate'
import { FONT, GRADIENT, barCells, cut, duration, homeOf, isPartOn, log, oneLine, paletteAt, readSwitches, svgStyle, xml } from './suite'

const NAME = 'session-ledger'
const DAYS = 7

/** The report's period tab, shared with the press handlers in inventory.tsx. */
export const periodAtom = atom({ plugin: 'session-ledger', key: 'period' } as const, 'day' as Period)

// The job in progress in this chat.
let job: { title: string; startedAt: number; minutes: number; helperMinutes: number; calls: number; steps: number } | null = null
let sid = ''

const pad = (n: number) => String(n).padStart(2, '0')
const monthOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
}
const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function ledgerDir($: EngineInterface) {
  return `${homeOf($)}/.claude/mods-state/ledger`
}

async function reportOn($: EngineInterface) {
  const json = await readSwitches($)
  return json[NAME] !== false && isPartOn(json, NAME, 'report')
}

/** A new prompt starts a job. Slash commands are not jobs. */
export async function reportPrompt($: EngineInterface, text: string) {
  if (!(await reportOn($))) return
  const t = oneLine(text)
  if (!t || t.startsWith('/')) return
  job = { title: cut(t, 80), startedAt: await $.clock.now(), minutes: 0, helperMinutes: 0, calls: 0, steps: 0 }
}

/** One main-chat tool call finished. */
export async function reportTool($: EngineInterface, e: { tool: unknown; agentId?: string }, ran: { deny?: unknown; isError?: boolean }) {
  if (!job) return
  const tool = String(e.tool)
  if (tool.startsWith('mcp__session-ledger__') || tool.startsWith('mcp__mod-switchboard__')) return
  job.calls += 1
  if (ran.deny !== undefined || ran.isError === true) return
  // Helpers' calls count too: their work is work saved.
  const m = narrate(tool, e as unknown as Record<string, unknown>).minutes
  job.minutes += m
  if (e.agentId) job.helperMinutes += m
  if (tool === 'mcp__ccd_turn__update_plan' || tool === 'TodoWrite' || tool === 'mcp__mission-control__plan') {
    const input = e as unknown as { advance?: unknown; done?: unknown; items?: unknown; todos?: unknown; steps?: unknown }
    if (input.advance === true) job.steps += 1
    if (Array.isArray(input.done)) job.steps += input.done.length
  }
}

/** The main chat's turn ended: a job with tool calls goes in the log. */
export async function reportTurn($: EngineInterface, e: { agentId?: string }) {
  if (e.agentId || !job) return
  const done = job
  job = null
  if (!done.calls || !(await reportOn($))) return
  try {
    if (!sid) sid = await $.session.id()
    const t = await $.clock.now()
    const dir = `${ledgerDir($)}/${monthOf(t)}`
    const path = `${dir}/${sid || 'chat'}.jsonl`
    let old = ''
    if (await $.fs.exists(path)) old = String(await $.fs.read(path))
    else await $.process.run(['mkdir', '-p', dir])
    const model = await $.session.model().catch(() => '')
    const line: Job = { t, minutes: Math.round(done.minutes), helperMinutes: Math.round(done.helperMinutes), calls: done.calls, steps: done.steps, title: done.title, model }
    await $.fs.write(path, `${old}${JSON.stringify(line)}\n`)
  } catch (err) {
    await log($, NAME, `report write: ${String(err)}`)
  }
}

/** Every job in the last `months` month folders. */
export async function readJobs($: EngineInterface, now: number, months = 2): Promise<Job[]> {
  const out: Job[] = []
  const d = new Date(now)
  for (let k = 0; k < months; k += 1) {
    const m = new Date(d.getFullYear(), d.getMonth() - k, 1).getTime()
    const dir = `${ledgerDir($)}/${monthOf(m)}`
    let files: { name: string; kind: string }[] = []
    try {
      files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      try {
        for (const raw of String(await $.fs.read(`${dir}/${f.name}`)).split('\n')) {
          if (!raw.trim()) continue
          const j = JSON.parse(raw) as Job
          if (typeof j.t === 'number' && typeof j.minutes === 'number') out.push(j)
        }
      } catch {
        // A broken line or file is skipped.
      }
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

/** Start of today, this week (Monday), this month and this year, local time. */
function starts(now: number): Record<Period, number> {
  const d = new Date(now)
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const dow = (d.getDay() + 6) % 7
  const week = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow).getTime()
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  const year = new Date(d.getFullYear(), 0, 1).getTime()
  return { day, week, month, year }
}

export function totals(jobs: Job[], from: number, rate: number): Totals {
  const list = jobs.filter(j => j.t >= from)
  const minutes = list.reduce((n, j) => n + j.minutes, 0)
  return { tasks: list.length, minutes, value: (minutes / 60) * rate }
}

// "Where the time went": a plain-words reading of each task's title. Today and this week use the
// specific kinds; this month and this year fold them into a few broad ones.
const KINDS: { key: string; label: string; broad: string; re: RegExp }[] = [
  { key: 'code', label: 'Code and fixes', broad: 'Building', re: /\b(code|bug|fix\w*|debug\w*|build\w*|deploy\w*|repo|git|test\w*|script|api|mods?|plugin|function|error|app)\b/i },
  { key: 'setup', label: 'Setup and tools', broad: 'Building', re: /\b(install\w*|set ?up|config\w*|settings?|connect\w*|folder|organi[sz]e|clean ?up|automat\w*)\b/i },
  { key: 'writing', label: 'Writing and email', broad: 'Communicating', re: /\b(email|e-mail|write|writ\w+|draft\w*|post|copy|letter|reply|message|text|blog|caption|note)\b/i },
  { key: 'design', label: 'Design and media', broad: 'Creating', re: /\b(design\w*|logo|image|video|photo|ui|page|slide|deck|brand\w*|figma|website|site)\b/i },
  { key: 'research', label: 'Research', broad: 'Thinking', re: /\b(research\w*|find|search\w*|look ?up|compare|analy\w+|review\w*|read|summar\w+|explain)\b/i },
  { key: 'money', label: 'Money and numbers', broad: 'Thinking', re: /\b(money|budget|tax\w*|invoice\w*|price\w*|pricing|cost\w*|credit|financ\w+|revenue|sales|\$\d)/i },
  { key: 'planning', label: 'Planning', broad: 'Planning', re: /\b(plan\w*|schedul\w*|calendar|to-?dos?|tasks?|strategy|meeting|roadmap)\b/i },
]
const OTHER = { key: 'other', label: 'Other', broad: 'Other' }
const BROAD = ['Building', 'Communicating', 'Creating', 'Thinking', 'Planning', 'Other']

export function kindOf(title: string) {
  return KINDS.find(k => k.re.test(title)) ?? OTHER
}

/** One colour per kind, the same in every view, so dots and bars match. */
function colorOfKind(label: string) {
  const specific = [...KINDS, OTHER].findIndex(k => k.label === label)
  return paletteAt(specific >= 0 ? specific : BROAD.indexOf(label))
}

function breakdown(list: Job[], broad: boolean) {
  const map = new Map<string, { minutes: number; count: number }>()
  for (const j of list) {
    const k = kindOf(j.title)
    const label = broad ? k.broad : k.label
    const cur = map.get(label) ?? { minutes: 0, count: 0 }
    map.set(label, { minutes: cur.minutes + j.minutes, count: cur.count + 1 })
  }
  const total = [...map.values()].reduce((a, b) => a + b.minutes, 0) || 1
  return [...map.entries()].map(([label, v]) => ({ label, minutes: v.minutes, count: v.count, share: v.minutes / total })).sort((a, b) => b.minutes - a.minutes)
}

/** "claude-opus-5-5" -> "Opus 5.5", with the model's colour. */
function modelOf(id?: string): { name: string; color: string } {
  const m = /(haiku|sonnet|opus|fable)[-\s]?(\d+)?(?:[-.](\d+))?/i.exec(id ?? '')
  if (!m) return { name: 'Claude', color: GRADIENT[1] }
  const fam = m[1]!.toLowerCase()
  const name = `${fam.charAt(0).toUpperCase()}${fam.slice(1)}${m[2] ? ` ${m[2]}${m[3] ? `.${m[3]}` : ''}` : ''}`
  const color = fam === 'haiku' ? '#22C55E' : fam === 'sonnet' ? '#F5A524' : fam === 'fable' ? '#4F7DF3' : GRADIENT[1]
  return { name, color }
}

type Day = { key: string; label: string; minutes: number; parts: { color: string; minutes: number }[] }

/** The last DAYS days, oldest first, each split by where the time went. */
function daily(jobs: Job[], now: number): Day[] {
  const out: Day[] = []
  const d = new Date(now)
  for (let k = DAYS - 1; k >= 0; k -= 1) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - k)
    out.push({ key: dayKey(day.getTime()), label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day.getDay()]!, minutes: 0, parts: [] })
  }
  const byKey = new Map(out.map(x => [x.key, x]))
  for (const j of jobs) {
    const hit = byKey.get(dayKey(j.t))
    if (!hit) continue
    hit.minutes += j.minutes
    const color = colorOfKind(kindOf(j.title).label)
    const part = hit.parts.find(p => p.color === color)
    if (part) part.minutes += j.minutes
    else hit.parts.push({ color, minutes: j.minutes })
  }
  return out
}

/** Days in a row with saved time, ending today (or yesterday, before today's first job). */
function streak(days: Day[]) {
  let n = 0
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i]!.minutes > 0) n += 1
    else if (i === days.length - 1) continue
    else break
  }
  return n
}

const dollars = (n: number) => `$${n < 1000 ? n.toFixed(0) : Math.round(n).toLocaleString('en-US')}`
const hours = (minutes: number) => `${(minutes / 60).toFixed(1)} h`

/** A thin rounded bar, tinted track and solid fill. */
const lineSvg = (ratio: number, W: number, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="10" viewBox="0 0 ${W} 10"><rect y="3" width="${W}" height="4" rx="2" fill="${color}" opacity=".16"/>` +
  `<rect y="3" width="${ratio > 0 ? Math.max(4, Math.round(W * ratio)) : 0}" height="4" rx="2" fill="${color}"/></svg>`

/** Seven columns, each stacked by where that day's time went, in the same colours as the dots. */
function weekSvg(days: Day[], W: number): string {
  const H = 120
  const base = H - 20
  const top = Math.max(60, ...days.map(d => d.minutes))
  const gap = 10
  const bw = Math.max(10, Math.floor((W - gap * (days.length - 1)) / days.length))
  const cols = days
    .map((d, i) => {
      const x = i * (bw + gap)
      const today = i === days.length - 1
      let y = base
      const segs = d.parts
        .sort((a, b) => b.minutes - a.minutes)
        .map(p => {
          const h = Math.max(3, Math.round((p.minutes / top) * (base - 16)))
          y -= h
          return `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(1, h - 1)}" rx="2" fill="${p.color}"/>`
        })
        .join('')
      const empty = d.minutes ? '' : `<rect x="${x}" y="${base - 3}" width="${bw}" height="3" rx="1.5" class="trk"/>`
      const val = d.minutes ? `<text x="${x + bw / 2}" y="${y - 4}" text-anchor="middle" class="mut" font-family="${FONT}" font-size="9">${xml(hours(d.minutes))}</text>` : ''
      const name = `<text x="${x + bw / 2}" y="${H - 4}" text-anchor="middle" font-family="${FONT}" font-size="10" ${today ? `fill="${GRADIENT[1]}" font-weight="700"` : 'class="mut"'}>${xml(d.label)}</text>`
      return segs + empty + val + name
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svgStyle()}${cols}</svg>`
}

const PERIODS: { id: Period; label: string; since: string; head: string }[] = [
  { id: 'day', label: 'Today', since: 'today', head: "TODAY'S WORK" },
  { id: 'week', label: 'Week', since: 'this week', head: "THIS WEEK'S WORK" },
  { id: 'month', label: 'Month', since: 'this month', head: "THIS MONTH'S WORK" },
  { id: 'year', label: 'Year', since: 'this year', head: "THIS YEAR'S WORK" },
]

const TILE = { hours: '#F5A524', tasks: '#4F7DF3', value: '#22C55E' }

/** The Report tab. `rate` is dollars per hour from the mod's settings. */
export async function reportView($: EngineInterface, els: Record<string, any>, surface: string, width: number, rate: number) {
  const { Box, Text, Button } = els
  if (!(await reportOn($))) return <Text dimColor>The report is switched off. Turn it on in /mods.</Text>
  const now = await $.clock.now()
  const period = await read($, periodAtom)
  const meta = PERIODS.find(p => p.id === period) ?? PERIODS[0]!
  const jobs = await readJobs($, now, period === 'year' ? 12 : 2)
  const from = starts(now)[period]
  const list = jobs.filter(j => j.t >= from)
  const t = totals(jobs, from, rate)
  const Svg = surface !== 'terminal' && 'Svg' in els ? els.Svg : null
  const dateText = new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
  const section = (text: string) => <Text key={`s-${text}`} dimColor bold size="caption">{text}</Text>

  // Rows: dot, name, thin bar, count, hours. Fixed columns so every row lines up.
  const labelW = Math.min(20, Math.max(10, Math.floor(width * 0.34)))
  const barCols = Math.max(6, width - labelW - 18)
  const bar = (key: string, ratio: number, color: string) => {
    if (Svg) return <Svg key={key} source={lineSvg(ratio, barCols * 7, color)} alt="" width={barCols * 7} height={10} />
    const { fill, rest } = barCells(ratio, barCols)
    return (
      <Text key={key}>
        <Text color={color}>{'━'.repeat(fill.length)}</Text>
        <Text dimColor>{'─'.repeat(rest)}</Text>
      </Text>
    )
  }
  const row = (key: string, color: string, label: string, ratio: number, count: number, unit: string, minutes: number) => (
    <Box key={key} flexDirection="row" alignItems="center" columnGap={1} width={width}>
      <Text color={color}>●</Text>
      <Box width={labelW} flexShrink={0}>
        <Text wrap="truncate-end">{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>{bar(`${key}-bar`, ratio, color)}</Box>
      <Box width={9} flexShrink={0} justifyContent="flex-end">
        <Text tabular>
          <Text bold>{String(count)}</Text>
          <Text dimColor>{` ${unit}`}</Text>
        </Text>
      </Box>
      <Box width={6} flexShrink={0} justifyContent="flex-end">
        <Text dimColor tabular>{hours(minutes)}</Text>
      </Box>
    </Box>
  )

  const tileW = Math.max(12, Math.floor((width - 2) / 3))
  const tile = (key: string, label: string, value: string, sub: string, color: string, hot: boolean) => (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={hot ? color : '#3F3F46'} paddingX={1} width={tileW}>
      <Text dimColor bold size="caption">{label}</Text>
      <Text bold size="title" color={color}>{value}</Text>
      <Text dimColor size="caption">{sub}</Text>
    </Box>
  )

  // Where the time went: specific kinds for today and this week, broad ones for month and year.
  const broad = period === 'month' || period === 'year'
  const kinds = breakdown(list, broad)
  const kindTop = Math.max(1, ...kinds.map(k => k.minutes))
  const kindRows = kinds.map((k, i) => row(`k${i}`, colorOfKind(k.label), k.label, k.minutes / kindTop, k.count, k.count === 1 ? 'task' : 'tasks', k.minutes))

  // Who did the work: each model, then the helpers it sent.
  const byModel = new Map<string, { color: string; minutes: number; count: number }>()
  for (const j of list) {
    const m = modelOf(j.model)
    const cur = byModel.get(m.name) ?? { color: m.color, minutes: 0, count: 0 }
    byModel.set(m.name, { color: m.color, minutes: cur.minutes + Math.max(0, j.minutes - (j.helperMinutes ?? 0)), count: cur.count + 1 })
  }
  const helperJobs = list.filter(j => (j.helperMinutes ?? 0) > 0)
  const helperMin = helperJobs.reduce((n, j) => n + (j.helperMinutes ?? 0), 0)
  const who = [...byModel.entries()].map(([name, v]) => ({ name, ...v }))
  if (helperMin) who.push({ name: 'Helpers', color: '#A78BFA', minutes: helperMin, count: helperJobs.length })
  who.sort((a, b) => b.minutes - a.minutes)
  const whoTop = Math.max(1, ...who.map(w => w.minutes))
  const whoRows = who.map((w, i) => row(`w${i}`, w.color, w.name, w.minutes / whoTop, w.count, w.count === 1 ? 'task' : 'tasks', w.minutes))

  const days = daily(jobs, now)
  const week = days.reduce((n, d) => n + d.minutes, 0)
  const run = streak(days)
  const px = Math.max(220, Math.min(900, width * 7))
  const top = Math.max(1, ...days.map(d => d.minutes))
  const chart = Svg ? (
    <Svg key="chart" source={weekSvg(days, px)} alt={`Hours saved per day, last ${DAYS} days`} width={px} height={120} />
  ) : (
    <Box key="chart" flexDirection="column">
      <Text>
        {days.map((d, i) => {
          const glyph = d.minutes ? '▁▂▃▄▅▆▇█'[Math.round((d.minutes / top) * 7)]! : '·'
          return <Text key={`b${i}`} color={d.parts[0]?.color} dimColor={!d.minutes}>{` ${glyph}  `}</Text>
        })}
      </Text>
      <Text dimColor>{days.map(d => `${d.label} `).join('')}</Text>
    </Box>
  )

  const shown = (period === 'day' ? [...list].reverse() : [...list].sort((a, b) => b.minutes - a.minutes)).slice(0, 6)
  return (
    <Box flexDirection="column" width={width} gap="sm">
      <Box key="periods" flexDirection="row" columnGap={1}>
        {PERIODS.map(p => <Button key={`per-${p.id}`} variant={p.id === period ? 'primary' : undefined} label={p.label} onPress={() => undefined} />)}
      </Box>
      <Box key="head" flexDirection="row" justifyContent="space-between" width={width}>
        <Text bold color={GRADIENT[1]}>{meta.head}</Text>
        <Text dimColor>{dateText}</Text>
      </Box>
      <Box key="tiles" flexDirection="row" columnGap={1} width={width}>
        {tile('t-hrs', 'HOURS SAVED', (t.minutes / 60).toFixed(1), 'estimate', TILE.hours, true)}
        {tile('t-tasks', 'TASKS DONE', String(t.tasks), 'finished tasks', TILE.tasks, false)}
        {tile('t-val', 'DOLLARS WORTH', dollars(t.value), `at $${rate}/hour`, TILE.value, false)}
      </Box>
      <Box key="where" flexDirection="column">
        {section('WHERE THE TIME WENT')}
        {kindRows.length ? kindRows : <Text dimColor>{`Nothing logged ${meta.since} yet.`}</Text>}
      </Box>
      <Box key="who" flexDirection="column">
        {section('WHO DID THE WORK')}
        {whoRows.length ? whoRows : <Text dimColor>The model behind each task shows here.</Text>}
      </Box>
      <Box key="week" flexDirection="column">
        {section(`LAST ${DAYS} DAYS`)}
        {chart}
        <Text>
          <Text bold>{`${(week / 60).toFixed(1)} hours saved in the last ${DAYS} days`}</Text>
          <Text dimColor>{` · ${run} day streak`}</Text>
        </Text>
      </Box>
      <Box key="tasks" flexDirection="column">
        {section(period === 'day' ? "TODAY'S TASKS" : `BIGGEST TASKS ${meta.since.toUpperCase()}`)}
        {shown.length ? null : <Text dimColor>A task is logged when Claude finishes a request that used tools.</Text>}
        {shown.map((j, i) => {
          const k = kindOf(j.title)
          return (
            <Box key={`j${i}`} flexDirection="row" justifyContent="space-between" width={width}>
              <Box flexGrow={1} flexShrink={1} flexDirection="row">
                <Text color={colorOfKind(broad ? k.broad : k.label)}>● </Text>
                <Text wrap="truncate-end">{j.title}</Text>
              </Box>
              <Text dimColor tabular>{` ${hours(j.minutes)}`}</Text>
            </Box>
          )
        })}
      </Box>
      <Text dimColor size="caption" wrap="wrap">{`Time saved is an estimate of how long a person would take, valued at $${rate}/hour.`}</Text>
    </Box>
  )
}

/** /report: the same numbers as text, for a quick read or to paste. */
export async function reportText($: EngineInterface, rate: number) {
  const now = await $.clock.now()
  const jobs = await readJobs($, now, 12)
  const s = starts(now)
  const row = (label: string, x: Totals) => `${label.padEnd(11)} ${String(x.tasks).padStart(4)} tasks   ${duration(x.minutes).padStart(7)} saved   ${dollars(x.value)}`
  const today = breakdown(jobs.filter(j => j.t >= s.day), false)
  return [
    `Session Ledger report · ${new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
    row('Today', totals(jobs, s.day, rate)),
    row('This week', totals(jobs, s.week, rate)),
    row('This month', totals(jobs, s.month, rate)),
    row('This year', totals(jobs, s.year, rate)),
    ...(today.length ? ['', 'Where today went:', ...today.map(k => `- ${k.label}: ${duration(k.minutes)} (${Math.round(k.share * 100)}%)`)] : []),
    `Estimated at $${rate} an hour of a person's time. Open /ledger for the chart.`,
  ].join('\n')
}
