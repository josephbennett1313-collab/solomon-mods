// Session Keeper (Solomon Mods): keeps a chat cheap and tells you the best move right now.
// - The bar: crab, a health grade (A to F), cache minutes left, context %, "rewrite ≈ $" (what re-reading the chat costs
//   once the cache is cold), "session $" (this chat's /cost), 5-hour and weekly use.
// - The smart button: the one command that helps most right now (Compact, Handoff, Doctor ...),
//   with why. The ▾ opens a balanced grid of every command this Claude Code has.
// - The hold: when the cache has gone cold, your message waits while you see "send now $X vs a
//   warm turn $Y": Pay and send, Start fresh, or Cache status.
// - Handoff: asks which device you are moving to (Mac mini, MacBook, iPhone) and writes the
//   handoff for that device, then starts the fresh chat or copies it for the other device.
// Written for Solomon Mods. Ideas credited in SOURCES.md; no code copied from other mods.

import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Bar, Device, Handoff, Hold, Suggest, Tip } from '../types'
import { DESCRIBE, GROUPS } from './commands'
import { ACCENT, STATUS, barCells, barSvg, crabGlyph, crabSvg, homeOf, log, money, partOn, roomy, tokenText } from './suite'

const NAME = 'session-keeper'
const BAR = { plugin: 'session-keeper', key: 'bar' } as const
const SUGGEST = { plugin: 'session-keeper', key: 'suggest' } as const
const HOLD = { plugin: 'session-keeper', key: 'hold' } as const
const HANDOFF = { plugin: 'session-keeper', key: 'handoff' } as const
const EXPANDED = { plugin: 'session-keeper', key: 'expanded' } as const
const NOTE = { plugin: 'session-keeper', key: 'note' } as const
const WARM_UNTIL = { plugin: 'session-keeper', key: 'warmUntil' } as const

const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000
const HOLD_MIN_TOKENS = 20_000
const OFFER_TOKENS = 250_000
const WARM_LEAD = 60_000
const WARM_MAX = 2 * ONE_HOUR
const BACKGROUND = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'channel', 'coordinator', 'observer', 'observer-activity', 'auto-continuation'])

/** Published prices, US$ per million input tokens and per million cache-read tokens (Nov 2026). */
const PRICES: { match: RegExp; input: number; read: number }[] = [
  { match: /fable|mythos/i, input: 10, read: 0.25 },
  { match: /opus-5-5|opus 5\.5|opus-5\.5/i, input: 4, read: 0.2 },
  { match: /opus-5\b|opus 5\b/i, input: 5, read: 0.5 },
  { match: /opus/i, input: 5, read: 0.5 },
  { match: /sonnet-5|sonnet 5/i, input: 2, read: 0.2 },
  { match: /sonnet/i, input: 3, read: 0.3 },
  { match: /haiku-5|haiku 5/i, input: 0.1, read: 0.01 },
  { match: /haiku/i, input: 1, read: 0.1 },
]
const priceOf = (model: string) => PRICES.find(p => p.match.test(model)) ?? { input: 4, read: 0.2 }

// Module values; a reload starts them over, the drawing lives in $.state.
let sid = ''
let available = new Set<string>()
let approved = ''
let errorsThisTurn = 0
let editsSinceReview = 0
let turns = 0
let offered = false
let warmTimer: { cancel: () => void } | null = null

const isPerson = (kind: string) => !BACKGROUND.has(kind)

const emptyBar = (): Bar => ({ now: Date.now(), lastEnd: 0, ttlMs: FIVE_MIN, ttlKnown: false, tokens: 0, percent: 0, sessionUsd: 0, fiveHour: null, week: null, model: '', fast: false })

async function patchBar($: EngineInterface, fn: (b: Bar) => Bar) {
  const { value } = await $.state.get(BAR)
  const base: Bar = value ?? emptyBar()
  await $.state.set(BAR, fn(base))
}

/** Reads the live figures from the engine: context, cost, limits. */
async function measure($: EngineInterface) {
  try {
    const u = await $.session.usage()
    const five = u.rateLimits.find(r => r.kind === 'five_hour')
    const week = u.rateLimits.find(r => r.kind === 'seven_day')
    const model = await $.session.model().catch(() => '')
    await patchBar($, b => ({
      ...b,
      now: Date.now(),
      tokens: u.context.tokens ?? b.tokens,
      percent: u.context.percent ?? b.percent,
      sessionUsd: u.cost?.usd ?? b.sessionUsd,
      fiveHour: five ? five.percentUsed : b.fiveHour,
      week: week ? week.percentUsed : b.week,
      model: model || b.model,
    }))
  } catch {
    // A missing figure leaves the last one standing.
  }
}

/** Reads this chat's cache length (5 min or 1 hour) from its log, via the small Python helper. */
async function detectTtl($: EngineInterface) {
  if (!sid) return
  try {
    const r = await $.process.run(['python3', `${$.plugin.root}/scripts/ttl.py`, sid])
    const out = String(r.stdout ?? '').trim()
    if (out === '1h' || out === '5m') await patchBar($, b => ({ ...b, ttlMs: out === '1h' ? ONE_HOUR : FIVE_MIN, ttlKnown: true }))
  } catch {
    // Unknown stays at the 5-minute guess.
  }
}

/** What re-reading the whole chat costs when the cache is cold, and what a warm turn costs. */
function costs(b: Bar) {
  const p = priceOf(b.model)
  const writeRate = b.ttlMs >= ONE_HOUR ? 2 : 1.25
  const speed = b.fast ? 2 : 1
  return {
    rewrite: (b.tokens / 1e6) * p.input * writeRate * speed,
    warm: (b.tokens / 1e6) * p.read * speed,
  }
}

/** A health grade for the chat, A to F, from how full the context is, the cache and recent errors. */
function grade(b: Bar): { letter: string; color: string } {
  let points = 100
  if (b.percent >= 85) points -= 45
  else if (b.percent >= 70) points -= 30
  else if (b.percent >= 50) points -= 15
  else if (b.percent >= 30) points -= 5
  if (isCold(b) && b.tokens > 100_000) points -= 15
  points -= Math.min(20, errorsThisTurn * 5)
  const letter = points >= 90 ? 'A' : points >= 78 ? 'B' : points >= 65 ? 'C' : points >= 50 ? 'D' : 'F'
  return { letter, color: letter === 'A' || letter === 'B' ? STATUS.good : letter === 'C' ? STATUS.warn : STATUS.bad }
}

const left = (b: Bar) => (b.lastEnd ? b.lastEnd + b.ttlMs - Date.now() : b.ttlMs)
const isCold = (b: Bar) => b.lastEnd > 0 && left(b) <= 0

const tip = (command: string, why: string): Tip => ({ command, label: `/${command}`, why })

/** The best next command, and two runners-up, from what the chat looks like now. */
function decide(b: Bar): Suggest {
  const c = costs(b)
  const list: { score: number; tip: Tip }[] = []
  const add = (score: number, command: string, why: string) => {
    if (command === 'handoff' || command === 'keepwarm' || available.size === 0 || available.has(command)) list.push({ score, tip: tip(command, why) })
  }
  const pct = b.percent
  if (isCold(b) && b.tokens > 150_000) add(95, 'handoff', `The cache is cold and the chat is ${tokenText(b.tokens)} tokens. Re-reading it costs about ${money(c.rewrite)}; a fresh chat with a handoff costs a few cents.`)
  if (pct >= 70) add(90, 'compact', `Context is ${Math.round(pct)}% full. Past about 70% Claude starts losing earlier details; compacting keeps the thread.`)
  if (b.tokens >= OFFER_TOKENS) add(85, 'handoff', `The chat passed ${tokenText(OFFER_TOKENS)} tokens. A handoff moves it to a fresh chat before auto-compact trims it.`)
  if (!isCold(b) && b.lastEnd && left(b) < 2 * 60_000 && b.tokens > 50_000) add(80, 'keepwarm', `The cache goes cold in under 2 minutes. Keeping it warm costs about ${money(c.warm)} a ping instead of ${money(c.rewrite)} to re-read.`)
  if ((b.fiveHour ?? 0) >= 85) add(78, 'model', `You have used ${Math.round(b.fiveHour ?? 0)}% of the 5-hour limit. A lighter model stretches what is left.`)
  if ((b.week ?? 0) >= 80) add(76, 'usage', `You have used ${Math.round(b.week ?? 0)}% of this week's limit. Check when it resets.`)
  if (errorsThisTurn >= 3) add(74, 'debug', `${errorsThisTurn} tool errors in the last turn. Debug finds the cause instead of retrying.`)
  if (errorsThisTurn >= 6) add(73, 'doctor', 'Many errors in a row can mean Claude Code itself needs a check.')
  if (editsSinceReview >= 5) add(70, 'code-review', `${editsSinceReview} files were edited and nothing has reviewed them yet.`)
  if (editsSinceReview >= 3) add(60, 'diff', 'See every change this chat made before you move on.')
  if (errorsThisTurn >= 2 && editsSinceReview >= 1) add(58, 'rewind', 'Edits were made and errors followed. Rewind takes the chat back to before them.')
  if (turns > 0 && turns % 10 === 0) add(35, 'stats', `${turns} turns in. Stats shows how this week's usage is trending.`)
  if (pct >= 45 && pct < 70) add(55, 'compact', `Context is ${Math.round(pct)}%. Compacting now, while the cache is warm, is cheaper than later.`)
  if (turns <= 1) add(40, 'context', 'See what is already loaded in this chat before you start.')
  if (turns > 1) add(30, 'btw', 'Ask a side question without pulling Claude off the task.')
  add(10, 'help', 'Every command, in one place.')
  list.sort((a, b2) => b2.score - a.score)
  const seen = new Set<string>()
  const unique = list.filter(x => (seen.has(x.tip.command) ? false : (seen.add(x.tip.command), true)))
  const main = unique[0]?.tip ?? tip('help', 'Every command, in one place.')
  return { main, others: unique.slice(1, 3).map(x => x.tip) }
}

async function refresh($: EngineInterface) {
  await measure($)
  const { value } = await $.state.get(BAR)
  if (value) await $.state.set(SUGGEST, decide(value))
}

// ---------- Actions ----------

async function runCommand($: EngineInterface, command: string) {
  if (command === 'handoff') return startHandoff($)
  if (command === 'keepwarm') return keepWarm($)
  try {
    await $.prompt.submit({ text: `/${command}`, asUser: true })
  } catch (err) {
    await $.state.set(NOTE, `Could not run /${command}: ${String(err).slice(0, 80)}`)
  }
}

async function keepWarm($: EngineInterface) {
  if (!(await partOn($, NAME, 'keepwarm'))) return $.state.set(NOTE, 'Keep warm is switched off in /mods.')
  const until = Date.now() + WARM_MAX
  await $.state.set(WARM_UNTIL, until)
  warmTimer?.cancel()
  warmTimer = $.clock.every(30_000, () => void warmTick($))
  await $.state.set(NOTE, 'Keeping the cache warm for up to 2 hours. A tiny ping runs just before it would go cold.')
}

async function warmTick($: EngineInterface) {
  const { value: until = 0 } = await $.state.get(WARM_UNTIL)
  const { value: b } = await $.state.get(BAR)
  if (!b || !until || Date.now() > until) {
    warmTimer?.cancel()
    warmTimer = null
    await $.state.set(WARM_UNTIL, 0)
    return
  }
  if (b.lastEnd && left(b) < WARM_LEAD) {
    // A forked one-line question re-reads the cached prefix and resets the timer.
    const r = await $.model.fork({ prompt: 'Reply with the single word: ok' })
    if (r.isAnswered) {
      await patchBar($, x => ({ ...x, lastEnd: Date.now() }))
      await log($, NAME, `${sid.slice(0, 8)} keep-warm ping read ${r.usage?.cache_read_input_tokens ?? 0}`)
    }
  }
}

// ---------- Handoff ----------

const DEVICE_NOTES: Record<Device, string> = {
  'Mac mini': 'The next chat runs on this same Mac mini, so file paths, folders and tools stay the same. Refer to files by their full paths.',
  MacBook: "The next chat runs on Joseph's MacBook, a different Mac. Local paths may differ; iCloud Drive and the Obsidian vault sync, other folders may not. Name which files live only on the Mac mini, and give GitHub links where a repo holds the work.",
  iPhone: "The next chat runs in the Claude app on Joseph's iPhone: no terminal, no local files, no running commands. Write it so it stands alone: paste the key facts, decisions and next steps in the text, give links instead of paths, and say which steps must wait for a Mac.",
}

async function startHandoff($: EngineInterface) {
  if (!(await partOn($, NAME, 'handoff'))) return $.state.set(NOTE, 'Handoff is switched off in /mods.')
  await $.state.set(HANDOFF, { phase: 'pick', device: '', file: '', text: '', note: '' })
}

async function writeHandoff($: EngineInterface, device: Device) {
  await $.state.set(HANDOFF, { phase: 'working', device, file: '', text: '', note: `Writing the handoff for your ${device}…` })
  const prompt = `Write a handoff so a fresh Claude chat can continue this work with nothing lost. ${DEVICE_NOTES[device]}

Use these headings, in plain language:
## What Joseph asked for
## Where things stand (done, in progress, not started)
## Decisions made and why
## Files, folders, repos and links used
## Open questions and risks
## Next steps (numbered, first one ready to run)

Leave out passwords, keys and tokens. Return only the handoff.`
  const r = await $.model.fork({ prompt })
  if (!r.isAnswered) {
    await $.state.set(HANDOFF, { phase: 'failed', device, file: '', text: '', note: `The handoff could not be written (${r.reason}). Try again in a moment.` })
    return
  }
  const text = `# Handoff for ${device}\n\n${r.text.trim()}\n`
  const dir = `${homeOf($)}/.claude/mods/handoffs`
  const file = `${dir}/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}-${sid.slice(0, 8)}.md`
  try {
    await $.process.run(['mkdir', '-p', dir])
    await $.fs.write(file, text)
  } catch {
    // The text is still on the panel to copy.
  }
  await $.state.set(HANDOFF, { phase: 'ready', device, file, text, note: device === 'Mac mini' ? 'Ready. Start the fresh chat here.' : `Ready. Copy it, then paste it into Claude on your ${device}.` })
}

async function finishHandoff($: EngineInterface, surface: unknown) {
  const { value: h } = await $.state.get(HANDOFF)
  if (!h || h.phase !== 'ready') return
  if (h.device === 'Mac mini') {
    await $.prompt.submit({ text: '/clear', asUser: true })
    await $.prompt.submit({ text: `Continue from this handoff (saved at ${h.file}):\n\n${h.text}`, asUser: true })
    await $.state.set(HANDOFF, null)
    return
  }
  const r = await $.ui.copy({ text: h.text, surface: surface as never })
  await $.state.set(HANDOFF, { ...h, note: r.isCopied ? `Copied. Open Claude on your ${h.device} and paste.` : `Copy failed. The file is at ${h.file}.` })
}

// ---------- Hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sid = await $.session.id().catch(() => '')
    try {
      available = new Set((await $.command.list()).map(c => c.name))
    } catch {
      available = new Set()
    }
    await $.command.register({ name: 'keeper', description: 'Session Keeper: open the command guide and cache status' })
    await $.command.register({ name: 'handoff', description: 'Write a handoff for your Mac mini, MacBook or iPhone and move on' })
    await $.command.register({ name: 'keepwarm', description: 'Keep the prompt cache warm for up to 2 hours' })
    await patchBar($, x => x)
    await refresh($)
    void detectTtl($)
    $.clock.every(15_000, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'keeper' }, async $ => {
    await $.state.set(EXPANDED, true)
    await refresh($)
    return { text: 'Session Keeper guide opened above the prompt.' }
  })
  on('command.run', { command: 'handoff' }, async $ => {
    await startHandoff($)
    return { text: 'Pick the device you are moving to, above the prompt.' }
  })
  on('command.run', { command: 'keepwarm' }, async $ => {
    await keepWarm($)
    return { text: 'Keep warm is on for up to 2 hours.' }
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      if ((r as { isError?: boolean }).isError) errorsThisTurn += 1
      const tool = String(e.tool)
      if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') editsSinceReview += 1
      if (tool === 'Skill' || tool === 'Agent') {
        const name = String((e as { skill?: string; subagent_type?: string }).skill ?? (e as { subagent_type?: string }).subagent_type ?? '')
        if (/review|simplify|verify/.test(name)) editsSinceReview = 0
      }
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command) {
      if (/review|simplify|verify/.test(e.command.name)) editsSinceReview = 0
      return next(e)
    }
    if (!isPerson(e.origin.kind) || e.turnId) return next(e)
    errorsThisTurn = 0
    // The hold: a cold cache and a big chat wait for a yes, once per message.
    const { value: b } = await $.state.get(BAR)
    if (b && isCold(b) && b.tokens >= HOLD_MIN_TOKENS && approved !== e.text && (await partOn($, NAME, 'hold'))) {
      const c = costs(b)
      const hold: Hold = { text: e.text, nowUsd: c.rewrite, warmUsd: c.warm, coldMins: Math.round(-left(b) / 60_000), tokens: b.tokens }
      await $.state.set(HOLD, hold)
      return { drop: 'Held by Session Keeper: the cache is cold. Choose above the prompt.' }
    }
    approved = ''
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      turns += 1
      await patchBar($, b => ({ ...b, lastEnd: Date.now() }))
      await refresh($)
      if (turns === 1 || turns % 5 === 0) void detectTtl($)
      const { value: b } = await $.state.get(BAR)
      if (b && b.tokens >= OFFER_TOKENS && !offered && (await partOn($, NAME, 'handoff'))) {
        offered = true
        $.ui.toast(`This chat passed ${tokenText(OFFER_TOKENS)} tokens. Session Keeper suggests a handoff.`)
      }
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await partOn($, NAME))) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const desktop = (e.surface === 'desktop' || e.surface === 'mobile') && 'Svg' in ui
    const width = Math.max(40, e.props.bodyColumns ?? e.viewport?.columns ?? 100)
    const b = (await $.state.get(BAR)).value ?? emptyBar()
    const { value: s } = await $.state.get(SUGGEST)
    const { value: hold } = await $.state.get(HOLD)
    const { value: h } = await $.state.get(HANDOFF)
    const { value: open = false } = await $.state.get(EXPANDED)
    const { value: note = '' } = await $.state.get(NOTE)
    const { value: warmUntil = 0 } = await $.state.get(WARM_UNTIL)
    const showBar = await partOn($, NAME, 'bar')
    const showCrab = await partOn($, NAME, 'fox')
    const showSuggest = await partOn($, NAME, 'suggest')
    const mine: RenderChildren[] = []
    const c = costs(b)
    const ms = left(b)
    const cold = isCold(b)
    const mins = Math.max(0, Math.ceil(ms / 60_000))
    const crab = (id: string, size = 24) =>
      showCrab ? (desktop ? <ui.Svg source={crabSvg(size, ACCENT, { id })} alt="Claude crab" width={size} height={Math.round((size * 13) / 18)} /> : <Text>{crabGlyph()}</Text>) : null

    // One card shape for the hold, the handoff and the guide: a small label, a title, a line under it.
    const card = (key: string, title: string, sub: string, body: RenderChildren[]) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} gap={1}>
        <Box flexDirection="row" columnGap={1} alignItems="center">
          {crab(`sk-${key}`, 28)}
          <Box flexDirection="column">
            <Text color={ACCENT} bold size="caption">SESSION KEEPER</Text>
            <Text bold size="heading">{title}</Text>
            {sub ? <Text dimColor>{sub}</Text> : null}
          </Box>
        </Box>
        {body}
      </Box>
    )
    // A thin bar: solid where filled, faint for the rest.
    const line = (key: string, ratio: number, color: string, w: number) => {
      if (desktop) return <ui.Svg key={key} source={barSvg(ratio, w * 7, 6, { color, id: key })} alt="" width={w * 7} height={6} />
      const { fill, rest } = barCells(ratio, w)
      return (
        <Text key={key}>
          <Text color={color}>{'━'.repeat(fill.length)}</Text>
          <Text dimColor>{'─'.repeat(rest)}</Text>
        </Text>
      )
    }
    const ago = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`)
    const perM = b.tokens ? c.rewrite / (b.tokens / 1e6) : 0

    // The hold comes first: nothing else matters until it is answered.
    if (hold) {
      const colW = Math.max(16, Math.floor((width - 8) / 2))
      const ratio = hold.nowUsd > 0 ? Math.min(1, hold.warmUsd / hold.nowUsd) : 0.05
      const col = (key: string, label: string, usd: number, color: string, r: number, sub: string) => (
        <Box key={key} flexDirection="column" width={colW}>
          <Text dimColor>{label}</Text>
          <Text bold size="heading" color={color}>{money(usd)}</Text>
          {line(`${key}-bar`, r, color, colW - 2)}
          <Text dimColor size="caption" wrap="truncate-end">{sub}</Text>
        </Box>
      )
      mine.push(
        card('hold', 'Your message is on hold', `The prompt cache went cold ${ago(hold.coldMins)} ago.`, [
          <Box key="costs" flexDirection="row" columnGap={2}>
            {col('now', 'Send it now', hold.nowUsd, ACCENT, 1, `re-writes ${hold.tokens.toLocaleString('en-US')} tokens at $${perM.toFixed(perM < 1 ? 2 : 0)}/MTok`)}
            {col('warm', 'A warm turn', hold.warmUsd, STATUS.good, ratio, 'what it would have cost')}
          </Box>,
          <Box key="lines" flexDirection="column">
            <Text dimColor wrap="truncate-end">
              <Text color={STATUS.warn}>⏸ </Text>On hold: “{hold.text.length > 80 ? `${hold.text.slice(0, 79)}…` : hold.text}”
            </Text>
            <Text dimColor>
              <Text color={STATUS.good}>⛨ </Text>Pay once and Keep warm then holds the cache for {WARM_MAX / ONE_HOUR}h00m.
            </Text>
          </Box>,
          <Box key="acts" flexDirection="row" columnGap={1}>
            <Button key="pay" variant="primary" label="Pay and send" onPress={async () => {
              approved = hold.text
              await $.state.set(HOLD, null)
              await $.prompt.submit({ text: hold.text, asUser: true })
            }} />
            <Button key="fresh" label="Start fresh" onPress={async () => {
              await $.state.set(HOLD, null)
              await $.ui.copy({ text: hold.text, surface: e.surface as never }).catch(() => undefined)
              await $.state.set(NOTE, 'Your message is on the clipboard. Paste it into the fresh chat after the handoff.')
              await startHandoff($)
            }} />
            <Button key="status" plain label="Show cache status" onPress={() => $.state.set(EXPANDED, true)} />
            <Button key="cancel" plain dimColor role="dismiss" label="Cancel" onPress={() => $.state.set(HOLD, null)} />
          </Box>,
        ]),
      )
    }

    if (h) {
      const devices: Device[] = ['Mac mini', 'MacBook', 'iPhone']
      const body: RenderChildren[] = []
      if (h.phase === 'pick') body.push(
        <Box key="devs" flexDirection="row" columnGap={1}>
          {devices.map(d => <Button key={`dev-${d}`} variant={d === 'Mac mini' ? 'primary' : undefined} label={d} onPress={() => void writeHandoff($, d)} />)}
          <Button key="ho-cancel" plain dimColor role="dismiss" label="Cancel" onPress={() => $.state.set(HANDOFF, null)} />
        </Box>,
      )
      if (h.phase === 'ready') body.push(
        <Box key="go" flexDirection="row" columnGap={1}>
          <Button key="ho-go" variant="primary" label={h.device === 'Mac mini' ? 'Start the fresh chat' : 'Copy handoff'} onPress={() => void finishHandoff($, e.surface)} />
          <Button key="ho-close" plain dimColor role="dismiss" label="Close" onPress={() => $.state.set(HANDOFF, null)} />
        </Box>,
      )
      if (h.phase === 'failed') body.push(<Button key="ho-retry" label="Try again" onPress={() => void startHandoff($)} />)
      mine.push(card('handoff', 'Handoff', h.phase === 'pick' ? 'Where will you pick this up? The handoff is written for that device.' : h.note, body))
    }

    const nice = (cmd: string) => (cmd === 'keepwarm' ? 'Keep warm' : cmd.charAt(0).toUpperCase() + cmd.slice(1).replace(/-/g, ' '))

    if (showBar) {
      const cacheColor = cold ? STATUS.bad : mins <= 2 ? STATUS.warn : STATUS.good
      const cacheText = !b.lastEnd ? 'cache ready' : cold ? 'cache cold' : `cache warm ${mins}m`
      const sep = <Text dimColor>{' │ '}</Text>
      const gr = grade(b)
      const main = s?.main.command ?? ''
      mine.push(
        <Box key="bar" flexDirection="row" alignItems="center" justifyContent="space-between" width={width}>
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            {crab('sk-bar')}
            <Text wrap="truncate-end">
              <Text color={gr.color} bold>{`${gr.letter} `}</Text>
              <Text color={cacheColor}>● </Text>
              <Text color={cacheColor} bold>{cacheText}</Text>
              {warmUntil > Date.now() ? <Text color={STATUS.info}> · keeping warm</Text> : null}
              {sep}
              <Text dimColor>ctx </Text>
              <Text color={b.percent >= 70 ? STATUS.bad : b.percent >= 50 ? STATUS.warn : undefined}>{tokenText(b.tokens)}</Text>
              <Text dimColor>{` (${Math.round(b.percent)}%)`}</Text>
              {sep}
              <Text dimColor>rewrite ≈ </Text>
              <Text color={cold ? STATUS.bad : undefined}>{money(c.rewrite)}</Text>
              {b.fiveHour !== null || b.week !== null ? sep : null}
              {b.fiveHour !== null ? <Text dimColor>{`5h ${Math.round(b.fiveHour)}%`}</Text> : null}
              {b.fiveHour !== null && b.week !== null ? <Text dimColor> · </Text> : null}
              {b.week !== null ? <Text dimColor>{`week ${Math.round(b.week)}%`}</Text> : null}
              {sep}
              <Text dimColor>session </Text>
              <Text>{money(b.sessionUsd)}</Text>
            </Text>
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={1}>
            {showSuggest && s ? <Button key="smart" variant="primary" label={nice(s.main.command)} onPress={() => void runCommand($, s.main.command)} /> : null}
            {main !== 'handoff' ? <Button key="fresh" label="Start fresh" onPress={() => void startHandoff($)} /> : null}
            {main !== 'keepwarm' ? <Button key="warm" label="Keep warm" onPress={() => void keepWarm($)} /> : null}
            <Button key="toggle" plain label={open ? '▴' : '▾'} onPress={() => $.state.set(EXPANDED, !open)} />
          </Box>
        </Box>,
      )
      if (showSuggest && s && !open) mine.push(
        <Text key="why" dimColor wrap="truncate-end">
          <Text dimColor>next: </Text>
          <Text color={ACCENT} bold>{nice(s.main.command)}</Text>
          <Text dimColor>{` · ${s.main.why}`}</Text>
        </Text>,
      )
    }

    if (open) {
      const cols = width >= 120 ? 4 : width >= 84 ? 3 : 2
      const cell = Math.floor((width - 4 - 2 * (cols - 1)) / cols)
      const body: RenderChildren[] = []
      if (s) {
        const tips: Tip[] = [s.main, ...s.others]
        body.push(
          <Box key="next" flexDirection="column">
            <Text dimColor>next:</Text>
            {tips.map((t, i) => (
              <Box key={`n-${t.command}`} flexDirection="row" columnGap={1}>
                <Text dimColor>{` ${i + 1} `}</Text>
                <Box width={14} flexShrink={0}>
                  <Button key={`tip-${t.command}`} plain onPress={() => void runCommand($, t.command)}>
                    <Text color={i === 0 ? ACCENT : undefined} bold={i === 0}>{nice(t.command)}</Text>
                  </Button>
                </Box>
                <Text dimColor wrap="truncate-end">{t.why}</Text>
              </Box>
            ))}
          </Box>,
        )
      }
      body.push(
        <Box key="status" flexDirection="row" columnGap={2}>
          <Text dimColor>{`Cache ${b.ttlKnown ? (b.ttlMs >= ONE_HOUR ? '1 hour' : '5 min') : '5 min (guess until the first reply)'}`}</Text>
          <Text dimColor>{`${tokenText(b.tokens)} tokens`}</Text>
          <Text dimColor>{`model ${b.model || 'unknown'}`}</Text>
          <Text dimColor>{`a warm turn ≈ ${money(c.warm)}`}</Text>
        </Box>,
      )
      for (const g of GROUPS) {
        const items = g.items.filter(([cmd]) => available.size === 0 || available.has(cmd))
        if (items.length === 0) continue
        const rows: [string, string][][] = []
        for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols))
        body.push(
          <Box key={`g-${g.title}`} flexDirection="column">
            <Text bold color={g.color}>{`● ${g.title}`}</Text>
            {rows.map((row, ri) => (
              <Box key={`r-${g.title}-${ri}`} flexDirection="row" columnGap={2}>
                {row.map(([cmd, what]) => (
                  <Box key={`c-${cmd}`} flexDirection="column" width={cell}>
                    <Button key={`cmd-${cmd}`} plain onPress={() => void runCommand($, cmd)}>
                      <Text color={g.color} bold>{`/${cmd}`}</Text>
                    </Button>
                    <Text dimColor size="caption" wrap="truncate-end">{what}</Text>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>,
        )
      }
      body.push(
        <Box key="acts" flexDirection="row" columnGap={1}>
          <Button key="g-handoff" label="Handoff" onPress={() => void startHandoff($)} />
          <Button key="g-warm" label="Keep warm" onPress={() => void keepWarm($)} />
          <Button key="g-close" plain dimColor role="dismiss" label="Close" onPress={() => $.state.set(EXPANDED, false)} />
        </Box>,
      )
      mine.push(card('guide', s ? `Best move now: ${nice(s.main.command)}` : 'Command guide', s ? s.main.why : 'Every command this Claude Code has, by what it is for.', body))
    }

    if (note) mine.push(
      <Box key="note" flexDirection="row" columnGap={1}>
        <Text dimColor>{note}</Text>
        <Button key="note-x" plain label="×" onPress={() => $.state.set(NOTE, '')} />
      </Box>,
    )

    const rest = await next(e)
    if (mine.length === 0) return rest
    return roomy(<Box flexDirection="column" gap={desktop ? 1 : 0}>{rest}{mine}</Box>, e.surface)
  })
}

// Kept for the help text of commands not in the catalogue.
export const describe = (cmd: string) => DESCRIBE.get(cmd) ?? ''
