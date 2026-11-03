// Today's Report (after Tristen O'Brien's idea): tasks done, hours saved and their dollar
// value, by day, week and month, across every chat. Each chat keeps its own log file, so two
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
import { FONT, GRADIENT, LIVE, STATUS, barCells, cut, duration, gradDefs, homeOf, isPartOn, log, oneLine, paletteAt, readSwitches, svgStyle, xml } from './suite'

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
    const line: Job = { t, minutes: Math.round(done.minutes), helperMinutes: Math.round(done.helperMinutes), calls: done.calls, steps: done.steps, title: done.title }
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
  const map = new Map<string, number>()
  for (const j of list) {
    const k = kindOf(j.title)
    const label = broad ? k.broad : k.label
    map.set(label, (map.get(label) ?? 0) + j.minutes)
  }
  const total = [...map.values()].reduce((a, b) => a + b, 0) || 1
  return [...map.entries()].map(([label, minutes]) => ({ label, minutes, share: minutes / total })).sort((a, b) => b.minutes - a.minutes)
}

/** Hours saved per day for the last DAYS days, oldest first. */
function daily(jobs: Job[], now: number) {
  const out: { key: string; label: string; minutes: number }[] = []
  const d = new Date(now)
  for (let k = DAYS - 1; k >= 0; k -= 1) {
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - k)
    out.push({ key: dayKey(day.getTime()), label: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day.getDay()]!, minutes: 0 })
  }
  const byKey = new Map(out.map(x => [x.key, x]))
  for (const j of jobs) {
    const hit = byKey.get(dayKey(j.t))
    if (hit) hit.minutes += j.minutes
  }
  return out
}

const dollars = (n: number) => `$${n < 1000 ? n.toFixed(0) : Math.round(n).toLocaleString('en-US')}`

/** A 7-day column chart for the desktop. */
function chartSvg(days: { label: string; minutes: number }[], W: number): string {
  const H = 96
  const top = Math.max(60, ...days.map(d => d.minutes))
  const gap = 10
  const bw = Math.max(8, Math.floor((W - gap * (days.length - 1)) / days.length))
  const bars = days
    .map((d, i) => {
      const h = d.minutes ? Math.max(3, Math.round((d.minutes / top) * (H - 30))) : 2
      const x = i * (bw + gap)
      const last = i === days.length - 1
      const hrs = d.minutes ? `<text x="${x + bw / 2}" y="${H - 20 - h}" text-anchor="middle" class="mut" font-family="${FONT}" font-size="9">${xml(duration(d.minutes))}</text>` : ''
      return `<rect x="${x}" y="${H - 16 - h}" width="${bw}" height="${h}" rx="4" fill="${d.minutes ? 'url(#cg)' : ''}" class="${d.minutes ? '' : 'trk'}"${last ? ` stroke="${LIVE}" stroke-width="1.5"` : ''}/>` +
        hrs +
        `<text x="${x + bw / 2}" y="${H - 3}" text-anchor="middle" class="mut" font-family="${FONT}" font-size="10">${xml(d.label)}</text>`
    })
    .join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svgStyle()}<defs><linearGradient id="cg" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${GRADIENT[2]}"/><stop offset="1" stop-color="${GRADIENT[0]}"/></linearGradient>${gradDefs('cgh')}</defs>${bars}</svg>`
}

const PERIODS: { id: Period; label: string; since: string }[] = [
  { id: 'day', label: 'Today', since: 'today' },
  { id: 'week', label: 'Week', since: 'this week' },
  { id: 'month', label: 'Month', since: 'this month' },
  { id: 'year', label: 'Year', since: 'this year' },
]

/** The Report tab. `rate` is dollars per hour from the mod's settings. */
export async function reportView($: EngineInterface, els: Record<string, any>, surface: string, width: number, rate: number) {
  const { Box, Text, Button } = els
  if (!(await reportOn($))) return <Text dimColor>Today's Report is switched off. Turn it on in /mods.</Text>
  const now = await $.clock.now()
  const period = await read($, periodAtom)
  const meta = PERIODS.find(p => p.id === period) ?? PERIODS[0]!
  const jobs = await readJobs($, now, period === 'year' ? 12 : 2)
  const from = starts(now)[period]
  const list = jobs.filter(j => j.t >= from)
  const t = totals(jobs, from, rate)
  const dateText = new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  const periodTabs = (
    <Box key="periods" flexDirection="row" gap={1}>
      {PERIODS.map(p => (
        <Button key={`per-${p.id}`} plain onPress={() => undefined}>
          <Text bold={p.id === period} color={p.id === period ? GRADIENT[1] : undefined} dimColor={p.id !== period}>
            {p.id === period ? `● ${p.label}` : p.label}
          </Text>
        </Button>
      ))}
    </Box>
  )

  const tileW = Math.floor((width - 2) / 3)
  const tile = (key: string, label: string, value: string, sub: string, color: string) => (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={tileW}>
      <Text dimColor size="caption">{label.toUpperCase()}</Text>
      <Text bold size="heading" color={color}>{value}</Text>
      <Text dimColor tabular wrap="truncate-end">{sub}</Text>
    </Box>
  )

  // Where the time went: specific kinds for today and this week, broad ones for month and year.
  const broad = period === 'month' || period === 'year'
  const kinds = breakdown(list, broad)
  const barW = Math.max(6, Math.min(28, width - 34))
  const kindRows = kinds.map((k, i) => {
    const color = colorOfKind(k.label)
    const { fill, rest } = barCells(k.share, barW)
    return (
      <Box key={`k${i}`} flexDirection="row" width={width}>
        <Text color={color}>● </Text>
        <Box width={18} flexShrink={0}>
          <Text wrap="truncate-end">{k.label}</Text>
        </Box>
        <Text color={color}>{'█'.repeat(fill.length)}</Text>
        <Text dimColor>{'░'.repeat(rest)}</Text>
        <Text tabular>{` ${duration(k.minutes)}`}</Text>
        <Text dimColor tabular>{` ${Math.round(k.share * 100)}%`}</Text>
      </Box>
    )
  })

  // Who did the work: the main chat versus helpers it sent.
  const helper = list.reduce((n, j) => n + (j.helperMinutes ?? 0), 0)
  const main = Math.max(0, t.minutes - helper)
  const whoW = Math.max(10, Math.min(40, width - 4))
  const mainCells = t.minutes ? Math.round((main / t.minutes) * whoW) : 0
  const who = (
    <Box key="who" flexDirection="column">
      <Text>
        <Text color={GRADIENT[1]}>{'█'.repeat(mainCells)}</Text>
        <Text color={paletteAt(3)}>{'█'.repeat(t.minutes ? whoW - mainCells : 0)}</Text>
        {t.minutes ? null : <Text dimColor>{'░'.repeat(whoW)}</Text>}
      </Text>
      <Text>
        <Text color={GRADIENT[1]}>● </Text>
        <Text>{`Claude ${duration(main)}`}</Text>
        <Text dimColor>{'   '}</Text>
        <Text color={paletteAt(3)}>● </Text>
        <Text>{`Helpers ${duration(helper)}`}</Text>
      </Text>
    </Box>
  )

  const days = daily(jobs, now)
  const Svg = surface !== 'terminal' && 'Svg' in els ? els.Svg : null
  const px = Math.max(200, Math.min(900, width * 7))
  const top = Math.max(1, ...days.map(d => d.minutes))
  const chart = Svg ? (
    <Svg key="chart" source={chartSvg(days, px)} alt={`Hours saved per day, last ${DAYS} days`} width={px} height={96} />
  ) : (
    <Box key="chart" flexDirection="column">
      <Text>
        {days.map((d, i) => {
          const lvl = Math.round((d.minutes / top) * 7)
          const glyph = d.minutes ? '▁▂▃▄▅▆▇█'[lvl]! : '·'
          return (
            <Text key={`b${i}`} color={d.minutes ? GRADIENT[i === days.length - 1 ? 0 : 1] : undefined} dimColor={!d.minutes}>
              {` ${glyph}  `}
            </Text>
          )
        })}
      </Text>
      <Text dimColor>{days.map(d => `${d.label} `).join('')}</Text>
    </Box>
  )

  const shown = (period === 'day' ? [...list].reverse() : [...list].sort((a, b) => b.minutes - a.minutes)).slice(0, 8)
  return (
    <Box flexDirection="column" width={width} gap="xs">
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Text bold>{dateText}</Text>
        <Text dimColor>{`$${rate}/hr`}</Text>
      </Box>
      {periodTabs}
      <Box flexDirection="row" gap={1} width={width}>
        {tile('t-val', `Value ${meta.since}`, dollars(t.value), `at $${rate} an hour`, GRADIENT[1])}
        {tile('t-hrs', 'Hours saved', duration(t.minutes), `${(t.minutes / 60).toFixed(1)} hours`, paletteAt(2))}
        {tile('t-tasks', 'Tasks done', String(t.tasks), t.tasks ? `about ${duration(Math.round(t.minutes / t.tasks))} each` : 'none yet', paletteAt(3))}
      </Box>
      <Text dimColor size="caption">{`WHERE THE TIME WENT · ${meta.since.toUpperCase()}`}</Text>
      {kindRows.length ? kindRows : <Text dimColor>Nothing logged {meta.since} yet.</Text>}
      <Text dimColor size="caption">WHO DID THE WORK</Text>
      {who}
      <Text dimColor size="caption">{`HOURS SAVED, LAST ${DAYS} DAYS`}</Text>
      {chart}
      <Text bold>{period === 'day' ? "Today's tasks" : `Biggest tasks ${meta.since}`}</Text>
      {shown.length ? null : <Text dimColor>A task is logged when Claude finishes a request that used tools.</Text>}
      {shown.map((j, i) => {
        const k = kindOf(j.title)
        return (
          <Box key={`j${i}`} flexDirection="row" justifyContent="space-between" width={width}>
            <Box flexGrow={1} flexShrink={1} flexDirection="row">
              <Text color={colorOfKind(broad ? k.broad : k.label)}>● </Text>
              <Text wrap="truncate-end">{j.title}</Text>
            </Box>
            <Text color={STATUS.good} tabular>{` ${duration(j.minutes)}`}</Text>
          </Box>
        )
      })}
      <Text dimColor wrap="wrap">{`Estimates: the time a person would take for each step that worked, valued at $${rate} an hour (change it in /config). Not a bill.`}</Text>
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
    `Today's Report · ${new Date(now).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
    row('Today', totals(jobs, s.day, rate)),
    row('This week', totals(jobs, s.week, rate)),
    row('This month', totals(jobs, s.month, rate)),
    row('This year', totals(jobs, s.year, rate)),
    ...(today.length ? ['', 'Where today went:', ...today.map(k => `- ${k.label}: ${duration(k.minutes)} (${Math.round(k.share * 100)}%)`)] : []),
    `Estimated at $${rate} an hour of a person's time. Open /ledger for the chart.`,
  ].join('\n')
}
