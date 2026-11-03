// Session Keeper (Solomon Mods): one panel above the prompt that keeps a chat cheap, with Auto Model inside it.
// - Top: the crab (it hops when the cache is warm; snow falls and it frosts over the longer the cache
//   has been cold), the ▾ guide and – size buttons, a one-line headline, the smart button, and five
//   rings on one line: quality (its letter inside), context, cache, 5 hours, week. Point at a ring
//   for what it means.
// - Token weather: a forecast word for how full the context is, the size, the last turns as little
//   bars, what re-reading costs once cold ("rewrite ≈ $") and this chat's cost so far ("session $").
// - Facts: how long the chat has been open, tool calls, edits, compactions, turns, git branch.
// - Cache: warm or cold in words, then its own row of buttons: Hand off to a fresh chat, Keep warm, Hide.
// - Auto Model: ON/OFF, the model and effort it picked and why, and the fast mode and Ultracode
//   buttons. Each press moves auto → on → off: auto lets Auto Model turn it on when a prompt needs it.
// - The hold: when the cache has gone cold, your message waits while you see "send now $X vs a warm
//   turn $Y": Pay and send, Start fresh, or Cancel.
// - Handoff: asks which device you are moving to (Mac mini, MacBook, iPhone) and writes the handoff
//   for that device, then starts the fresh chat or copies it for the other device.
// Written for Solomon Mods. Ideas credited in SOURCES.md; no code copied from other mods.

import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Bar, Device, Facts, Hold, Suggest, Tip } from '../types'
import { DESCRIBE, GROUPS } from './commands'
import {
  ACCENT,
  STATUS,
  amLabel,
  amModesOf,
  barCells,
  barSvg,
  clockTime,
  coldLevel,
  crabGlyph,
  crabSceneSvg,
  effortColor,
  friendlyModel,
  hairlineSvg,
  homeOf,
  isPartOn,
  log,
  modelColor,
  money,
  nextAmMode,
  partOn,
  plural,
  readSwitches,
  ringSvg,
  roomy,
  runAmCommand,
  sparkText,
  tokenText,
  weatherOf,
  writeSwitches,
} from './suite'
import type { AmFeature, AmMode } from './suite'

const NAME = 'session-keeper'
const BAR = { plugin: 'session-keeper', key: 'bar' } as const
const SUGGEST = { plugin: 'session-keeper', key: 'suggest' } as const
const HOLD = { plugin: 'session-keeper', key: 'hold' } as const
const HANDOFF = { plugin: 'session-keeper', key: 'handoff' } as const
const EXPANDED = { plugin: 'session-keeper', key: 'expanded' } as const
const NOTE = { plugin: 'session-keeper', key: 'note' } as const
const WARM_UNTIL = { plugin: 'session-keeper', key: 'warmUntil' } as const
const MIN = { plugin: 'session-keeper', key: 'min' } as const
const HIDDEN = { plugin: 'session-keeper', key: 'hidden' } as const
const FACTS = { plugin: 'session-keeper', key: 'facts' } as const
const HOSTING = { plugin: 'session-keeper', key: 'hosting' } as const
const AM_MODES = { plugin: 'session-keeper', key: 'amModes' } as const
// Auto Model's own values: this panel reads them, Auto Model writes them.
const AM_PICK = { plugin: 'auto-model', key: 'pick' } as const
const AM_LIVE = { plugin: 'auto-model', key: 'live' } as const
const AM_OWN = { plugin: 'auto-model', key: 'modes' } as const

const FIVE_MIN = 5 * 60_000
const ONE_HOUR = 60 * 60_000
const HOLD_MIN_TOKENS = 20_000
const OFFER_TOKENS = 250_000
const WARM_LEAD = 60_000
const WARM_MAX = 2 * ONE_HOUR
const COLD_BLUE = '#60A5FA'
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
let hist: number[] = [] // context size after each reply, for the little bars
let facts: Facts = { startedAt: Date.now(), tools: 0, edits: 0, compactions: 0, branch: '' }

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

/**
 * Reads this chat's cache length (5 min or 1 hour) and when its last reply ended, from its log,
 * via the small Python helper. A resumed chat has no reply in this run yet: the log says how long
 * its cache has been cold.
 */
async function detectTtl($: EngineInterface) {
  if (!sid) return
  try {
    const r = await $.process.run(['python3', '-I', `${$.plugin.root}/scripts/ttl.py`, sid])
    const [ttl = 'unknown', lastRaw = '0'] = String(r.stdout ?? '').trim().split(/\s+/)
    const last = Number(lastRaw) || 0
    await patchBar($, b => ({
      ...b,
      ...(ttl === '1h' || ttl === '5m' ? { ttlMs: ttl === '1h' ? ONE_HOUR : FIVE_MIN, ttlKnown: true } : {}),
      lastEnd: b.lastEnd || (last > 0 && last <= Date.now() ? last : 0),
    }))
  } catch {
    // Unknown stays at the 5-minute guess.
  }
}

/** The git branch the chat works on, for the facts row; empty outside a repository. */
async function readBranch($: EngineInterface) {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 5000 })
    facts = { ...facts, branch: r.exitCode === 0 ? String(r.stdout ?? '').trim() : '' }
  } catch {
    facts = { ...facts, branch: '' }
  }
}

const saveFacts = ($: EngineInterface) => $.state.set(FACTS, { ...facts })

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

/** A quality score for the chat, 0 to 100, with a letter: S 90+, A 80+, B 70+, C 55+, D 40+, F below. */
function grade(b: Bar): { score: number; letter: string; color: string } {
  let score = 100 - b.percent * 0.4
  if (b.percent > 70) score -= (b.percent - 70) * 0.6
  if (isCold(b) && b.tokens > 150_000) score -= 4
  score -= Math.min(20, errorsThisTurn * 5)
  score = Math.max(0, Math.min(100, Math.round(score)))
  const letter = score >= 90 ? 'S' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : score >= 40 ? 'D' : 'F'
  return { score, letter, color: score >= 80 ? STATUS.good : score >= 55 ? STATUS.warn : STATUS.bad }
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

/** True while this panel shows Auto Model's row, so Auto Model draws no chip of its own. */
async function syncHosting($: EngineInterface) {
  const json = await readSwitches($)
  const on = json[NAME] !== false && isPartOn(json, NAME, 'bar') && isPartOn(json, NAME, 'automodel') && (await $.state.get(HIDDEN)).value !== true
  if ((await $.state.get(HOSTING)).value !== on) await $.state.set(HOSTING, on)
}

async function refresh($: EngineInterface) {
  await measure($)
  const { value } = await $.state.get(BAR)
  if (value) await $.state.set(SUGGEST, decide(value))
  await saveFacts($)
  await syncHosting($)
}

// ---------- Actions ----------

/** Runs one of Claude Code's own commands from a button. Its output shows in the chat. */
async function runCommand($: EngineInterface, command: string) {
  if (command === 'handoff') return startHandoff($)
  if (command === 'keepwarm') return keepWarm($)
  try {
    await $.command.run({ command, args: '' })
  } catch (err) {
    await $.state.set(NOTE, `Could not run /${command}: ${String(err).slice(0, 100)}`)
  }
}

async function keepWarm($: EngineInterface) {
  if (!(await partOn($, NAME, 'keepwarm'))) return $.state.set(NOTE, 'Keep warm is switched off in /mods.')
  const until = Date.now() + WARM_MAX
  await $.state.set(WARM_UNTIL, until)
  warmTimer?.cancel()
  warmTimer = $.clock.every(30_000, () => void warmTick($))
  await $.state.set(NOTE, `Keeping the cache warm until ${clockTime(until)}. A tiny ping runs just before it would go cold.`)
}

async function stopWarm($: EngineInterface) {
  warmTimer?.cancel()
  warmTimer = null
  await $.state.set(WARM_UNTIL, 0)
  await $.state.set(NOTE, 'Stopped keeping the cache warm.')
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

function hide($: EngineInterface) {
  void $.state.set(HIDDEN, true).then(() => syncHosting($))
  try {
    $.ui.toast('Session Keeper hidden. Type /keeper to bring it back.')
  } catch {
    // Only a hint.
  }
}

// ---------- Auto Model's row ----------

const AM_SAYS: Record<AmMode, string> = {
  auto: 'auto: Auto Model turns it on by itself when a prompt calls for it, and off after',
  on: 'on for this chat',
  off: 'off for this chat; Auto Model leaves it off',
}

/** One press of fast mode or Ultracode: auto → on → off → auto, and the command that makes it so now. */
async function cycleAm($: EngineInterface, f: AmFeature) {
  const json = await readSwitches($, true)
  const cur = amModesOf(json, (await $.state.get(AM_MODES)).value, (await $.state.get(AM_OWN)).value)
  const mode = nextAmMode(cur[f])
  await $.state.set(AM_MODES, { ...cur, [f]: mode, at: Date.now() })
  const live = (await $.state.get(AM_LIVE)).value
  const liveOn = f === 'fast' ? live?.fast === true : live?.ultracode === true
  const name = f === 'fast' ? 'Fast mode' : 'Ultracode'
  let said = ''
  if (mode === 'on' && !liveOn) said = await runAmCommand($, f, true)
  else if (mode !== 'on' && liveOn) said = await runAmCommand($, f, false)
  await $.state.set(NOTE, `${name} ${AM_SAYS[mode]}.${said ? ` ${said}` : ''}`)
}

async function toggleAutoModel($: EngineInterface, on: boolean) {
  const json = await readSwitches($, true)
  await writeSwitches($, { ...json, 'auto-model': on })
  await $.state.set(NOTE, on ? 'Auto Model is on: it picks the model and effort each time you send.' : 'Auto Model is off: your own model and effort stay as set.')
}

// ---------- Handoff ----------

const DEVICE_NOTES: Record<Device, string> = {
  'Mac mini': 'The next chat runs on this same Mac mini, so file paths, folders and tools stay the same. Refer to files by their full paths.',
  MacBook: "The next chat runs on Joseph's MacBook, a different Mac. Local paths may differ; iCloud Drive and the Obsidian vault sync, other folders may not. Name which files live only on the Mac mini, and give GitHub links where a repo holds the work.",
  iPhone: "The next chat runs in the Claude app on Joseph's iPhone: no terminal, no local files, no running commands. Write it so it stands alone: paste the key facts, decisions and next steps in the text, give links instead of paths, and say which steps must wait for a Mac.",
}

async function startHandoff($: EngineInterface) {
  if (!(await partOn($, NAME, 'handoff'))) return $.state.set(NOTE, 'Handoff is switched off in /mods.')
  await $.state.set(HIDDEN, false)
  await $.state.set(MIN, false)
  await $.state.set(HANDOFF, { phase: 'pick', device: '', file: '', text: '', note: '' })
}

async function writeHandoff($: EngineInterface, device: Device) {
  await $.state.set(HANDOFF, { phase: 'working', device, file: '', text: '', note: `Writing the handoff for your ${device}… this takes about a minute.` })
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
  await $.state.set(HANDOFF, { phase: 'ready', device, file, text, note: device === 'Mac mini' ? 'Ready. Start the fresh chat here: the chat clears and the handoff is sent as your first message.' : `Ready. Copy it, then paste it into Claude on your ${device}.` })
}

async function finishHandoff($: EngineInterface, surface: unknown) {
  const { value: h } = await $.state.get(HANDOFF)
  if (!h || h.phase !== 'ready') return
  if (h.device === 'Mac mini') {
    await $.state.set(HANDOFF, { ...h, phase: 'working', note: 'Clearing the chat and starting fresh…' })
    try {
      await $.command.run({ command: 'clear', args: '' })
    } catch (err) {
      await $.state.set(HANDOFF, { ...h, note: `The chat could not be cleared (${String(err).slice(0, 80)}). Copy the handoff instead; it is saved at ${h.file}.` })
      return
    }
    await $.state.set(HANDOFF, null)
    facts = { startedAt: Date.now(), tools: 0, edits: 0, compactions: 0, branch: facts.branch }
    hist = []
    turns = 0
    await $.prompt.submit({ text: `Continue from this handoff (saved at ${h.file}):\n\n${h.text}`, asUser: true })
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
    await $.command.register({ name: 'keeper', description: 'Session Keeper: show the panel and open the command guide' })
    await $.command.register({ name: 'handoff', description: 'Write a handoff for your Mac mini, MacBook or iPhone and move on' })
    await $.command.register({ name: 'keepwarm', description: 'Keep the prompt cache warm for up to 2 hours' })
    const prev = (await $.state.get(FACTS)).value
    facts = prev ? { ...prev } : { startedAt: Date.now(), tools: 0, edits: 0, compactions: 0, branch: '' }
    await patchBar($, x => x)
    await readBranch($)
    await refresh($)
    void detectTtl($)
    $.clock.every(15_000, () => void refresh($))
    return next(e)
  })

  on('command.run', { command: 'keeper' }, async $ => {
    await $.state.set(HIDDEN, false)
    await $.state.set(MIN, false)
    await $.state.set(EXPANDED, true)
    await refresh($)
    return { text: 'Session Keeper is open above the prompt, with the command guide.' }
  })
  on('command.run', { command: 'handoff' }, async $ => {
    await startHandoff($)
    return { text: 'Pick the device you are moving to, in the Session Keeper panel.' }
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
      facts = { ...facts, tools: facts.tools + 1 }
      if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
        editsSinceReview += 1
        facts = { ...facts, edits: facts.edits + 1 }
      }
      if (tool === 'Skill' || tool === 'Agent') {
        const name = String((e as { skill?: string; subagent_type?: string }).skill ?? (e as { subagent_type?: string }).subagent_type ?? '')
        if (/review|simplify|verify/.test(name)) editsSinceReview = 0
      }
    }
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute') {
      facts = { ...facts, compactions: facts.compactions + 1 }
      hist = []
      await saveFacts($)
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
      return { drop: 'Held by Session Keeper: the cache is cold. Choose in the panel above the prompt.' }
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
      if (turns === 1 || turns % 5 === 0) {
        void detectTtl($)
        void readBranch($)
      }
      const { value: b } = await $.state.get(BAR)
      if (b) hist = [...hist, b.tokens].slice(-12)
      if (b && b.tokens >= OFFER_TOKENS && !offered && (await partOn($, NAME, 'handoff'))) {
        offered = true
        $.ui.toast(`This chat passed ${tokenText(OFFER_TOKENS)} tokens. Session Keeper suggests a handoff.`)
      }
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const json = await readSwitches($)
    if (json[NAME] === false) return next(e)
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const desktop = (e.surface === 'desktop' || e.surface === 'mobile') && 'Svg' in ui
    const width = Math.max(40, e.props.bodyColumns ?? e.viewport?.columns ?? 100)
    const b = (await $.state.get(BAR)).value ?? emptyBar()
    const { value: s } = await $.state.get(SUGGEST)
    const { value: hold } = await $.state.get(HOLD)
    const { value: ho } = await $.state.get(HANDOFF)
    const open = (await $.state.get(EXPANDED)).value === true
    const note = (await $.state.get(NOTE)).value ?? ''
    const warmUntil = (await $.state.get(WARM_UNTIL)).value ?? 0
    const min = (await $.state.get(MIN)).value === true
    const hidden = (await $.state.get(HIDDEN)).value === true
    const f = (await $.state.get(FACTS)).value ?? facts
    const showBar = isPartOn(json, NAME, 'bar')
    const showCrab = isPartOn(json, NAME, 'fox')
    const showSuggest = isPartOn(json, NAME, 'suggest')
    const showAm = isPartOn(json, NAME, 'automodel')

    // Spacing: the desktop draws native buttons taller than a text line, so it gets real gaps.
    const gapS = desktop ? 'sm' : 0
    const gapM = desktop ? 'md' : 0
    const padX = desktop ? 'md' : 1

    const c = costs(b)
    const ms = left(b)
    const cold = isCold(b)
    const coldMins = cold ? Math.max(1, Math.round(-ms / 60_000)) : 0
    const mins = Math.max(0, Math.ceil(ms / 60_000))
    const warming = warmUntil > Date.now()
    const gr = grade(b)
    const cacheColor = cold ? COLD_BLUE : b.lastEnd && mins <= 2 ? STATUS.warn : STATUS.good
    const ctxColor = b.percent >= 80 ? STATUS.bad : b.percent >= 60 ? STATUS.warn : STATUS.good
    const limColor = (v: number) => (v >= 90 ? STATUS.bad : v >= 75 ? STATUS.warn : STATUS.good)
    const winTok = b.percent > 0 ? Math.round(b.tokens / (b.percent / 100)) : 0
    const main = s?.main.command ?? ''
    const nice = (cmd: string) => (cmd === 'keepwarm' ? 'Keep warm' : cmd.charAt(0).toUpperCase() + cmd.slice(1).replace(/-/g, ' '))
    const ago = (m: number) => (m >= 60 * 24 ? `${Math.floor(m / (60 * 24))}d ${Math.floor((m % (60 * 24)) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`)
    const chill = coldLevel(coldMins)

    // ----- Small parts -----

    const crab = (key: string, w: number, id = 'skc') => {
      if (!showCrab) return null
      if (!desktop) return <Text key={key}>{chill ? `${crabGlyph()}❄` : crabGlyph()}</Text>
      const alt = chill ? `Claude crab in the snow: the cache has been cold for ${ago(coldMins)}` : 'Claude crab'
      return (
        <Box key={key} flexShrink={0}>
          <ui.Svg source={crabSceneSvg(w, ACCENT, { cold: chill, id })} alt={alt} width={w} height={Math.round((w * 19) / 24)} />
        </Box>
      )
    }
    const ring = (key: string, v: number, color: string, opts: { dashed?: boolean; label?: string } = {}) =>
      desktop ? (
        <ui.Svg key={key} source={ringSvg(v, color, { size: 22, ...opts })} alt="" width={22} height={22} />
      ) : (
        <Text key={key} color={color} bold>{opts.label ? `[${opts.label}]` : opts.dashed ? '◌' : v >= 66 ? '◕' : v >= 33 ? '◑' : v > 0 ? '◔' : '○'}</Text>
      )
    // A card that opens under a ring while the pointer is on it (desktop only).
    const hoverCard = (title: string, lines: string[], side: 'left' | 'right') =>
      desktop ? (
        <Box position="absolute" top={1} {...(side === 'left' ? { left: 0 } : { right: 0 })} display="none" hover={{ display: 'flex' }} flexDirection="column" width={38} paddingX={1} borderStyle="round" borderColor="subtle" backgroundColor="inverseText">
          <Text bold>{title}</Text>
          {lines.map((l, i) => (
            <Text key={`l${i}`} dimColor wrap="wrap">{l}</Text>
          ))}
        </Box>
      ) : null
    const mark = (id: string, glyph: RenderChildren, value: string, label: string, color: string, card: RenderChildren) => (
      <Box key={`sk-mark-${id}`} position="relative" flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
        {glyph}
        <Text bold color={color}>{value}</Text>
        <Text dimColor>{label}</Text>
        {card}
      </Box>
    )
    const rule = (key: string) =>
      desktop ? (
        <Box key={key} height={1} overflow="hidden">
          <ui.Svg source={hairlineSvg()} alt="" height={1} />
        </Box>
      ) : (
        <Text key={key} dimColor>{'─'.repeat(Math.max(10, width - 6))}</Text>
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
    // One shape for the hold, the handoff and the guide: a coloured frame, a small label, a line under it.
    const section = (key: string, label: string, sub: string, body: RenderChildren[], color: string = ACCENT) => (
      <Box key={key} flexDirection="column" borderStyle="round" borderColor={color} paddingX={padX} paddingY={desktop ? 'sm' : 0} rowGap={gapS}>
        <Text color={color} bold size="caption">{label}</Text>
        {sub ? <Text wrap="wrap">{sub}</Text> : null}
        {body}
      </Box>
    )
    const smart =
      showSuggest && s && main !== 'handoff' && main !== 'keepwarm' ? (
        <Box flexShrink={0}>
          <Button key="sk-smart" variant="primary" label={nice(main)} onPress={() => void runCommand($, main)} />
        </Box>
      ) : null

    // ----- The hold -----

    const holdPart = (() => {
      if (!hold) return null
      const ratio = hold.nowUsd > 0 ? Math.min(1, hold.warmUsd / hold.nowUsd) : 0.05
      const perM = hold.tokens ? hold.nowUsd / (hold.tokens / 1e6) : 0
      const col = (key: string, label: string, usd: number, color: string, r: number, sub: string) => (
        <Box key={key} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} rowGap={desktop ? 'xs' : 0}>
          <Text dimColor>{label}</Text>
          <Text bold size="heading" color={color}>{money(usd)}</Text>
          {line(`${key}-bar`, r, color, 22)}
          <Text dimColor size="caption" wrap="truncate-end">{sub}</Text>
        </Box>
      )
      return section('sk-hold', 'YOUR MESSAGE IS ON HOLD', `The prompt cache went cold ${ago(hold.coldMins)} ago, so sending now re-reads the whole chat at full price.`, [
        <Box key="sk-hold-costs" flexDirection="row" columnGap={gapM || 2}>
          {col('sk-hold-now', 'Send it now', hold.nowUsd, ACCENT, 1, `re-writes ${hold.tokens.toLocaleString('en-US')} tokens at $${perM.toFixed(perM < 1 ? 2 : 0)}/MTok`)}
          {col('sk-hold-warm', 'A warm turn', hold.warmUsd, STATUS.good, ratio, 'what it would have cost')}
        </Box>,
        <Text key="sk-hold-text" dimColor wrap="truncate-end">
          <Text color={STATUS.warn}>⏸ </Text>On hold: “{hold.text.length > 80 ? `${hold.text.slice(0, 79)}…` : hold.text}”
        </Text>,
        <Box key="sk-hold-acts" flexDirection="row" alignItems="center" columnGap={gapS || 1}>
          <Button key="sk-hold-pay" variant="primary" label="Pay and send" onPress={async () => {
            approved = hold.text
            await $.state.set(HOLD, null)
            await $.prompt.submit({ text: hold.text, asUser: true })
          }} />
          <Button key="sk-hold-fresh" label="Start fresh instead" onPress={async () => {
            await $.state.set(HOLD, null)
            await $.ui.copy({ text: hold.text, surface: e.surface as never }).catch(() => undefined)
            await $.state.set(NOTE, 'Your message is on the clipboard. Paste it into the fresh chat after the handoff.')
            await startHandoff($)
          }} />
          <Button key="sk-hold-cancel" role="dismiss" label="Cancel" onPress={() => $.state.set(HOLD, null)} />
        </Box>,
      ], STATUS.warn)
    })()

    // ----- The handoff -----

    const handoffPart = (() => {
      if (!ho) return null
      const devices: Device[] = ['Mac mini', 'MacBook', 'iPhone']
      const body: RenderChildren[] = []
      if (ho.phase === 'pick') body.push(
        <Box key="sk-ho-devs" flexDirection="row" alignItems="center" columnGap={gapS || 1}>
          {devices.map(d => (
            <Button key={`sk-ho-${d.replace(/\s/g, '').toLowerCase()}`} variant={d === 'Mac mini' ? 'primary' : undefined} label={d} onPress={() => void writeHandoff($, d)} />
          ))}
          <Button key="sk-ho-cancel" role="dismiss" label="Cancel" onPress={() => $.state.set(HANDOFF, null)} />
        </Box>,
      )
      if (ho.phase === 'ready') body.push(
        <Box key="sk-ho-go" flexDirection="row" alignItems="center" columnGap={gapS || 1}>
          <Button key="sk-ho-start" variant="primary" label={ho.device === 'Mac mini' ? 'Start the fresh chat' : 'Copy handoff'} onPress={() => void finishHandoff($, e.surface)} />
          {ho.device === 'Mac mini' ? <Button key="sk-ho-copy" label="Copy instead" onPress={async () => {
            const r = await $.ui.copy({ text: ho.text, surface: e.surface as never })
            await $.state.set(HANDOFF, { ...ho, note: r.isCopied ? 'Copied.' : `Copy failed. The file is at ${ho.file}.` })
          }} /> : null}
          <Button key="sk-ho-close" role="dismiss" label="Close" onPress={() => $.state.set(HANDOFF, null)} />
        </Box>,
      )
      if (ho.phase === 'failed') body.push(
        <Box key="sk-ho-fail" flexDirection="row" alignItems="center" columnGap={gapS || 1}>
          <Button key="sk-ho-retry" variant="primary" label="Try again" onPress={() => void startHandoff($)} />
          <Button key="sk-ho-close2" role="dismiss" label="Close" onPress={() => $.state.set(HANDOFF, null)} />
        </Box>,
      )
      if (ho.file && ho.phase === 'ready') body.push(<Text key="sk-ho-file" dimColor size="caption" wrap="truncate-middle">{`Saved at ${ho.file}`}</Text>)
      return section('sk-handoff', 'HANDOFF TO A FRESH CHAT', ho.phase === 'pick' ? 'Where will you pick this up? The handoff is written for that device.' : ho.note, body)
    })()

    // ----- The command guide (▾) -----

    const guidePart = (() => {
      if (!open) return null
      const cols = width >= 120 ? 4 : width >= 84 ? 3 : 2
      const cellPct = `${Math.floor(100 / cols) - 2}%`
      const body: RenderChildren[] = []
      if (s) {
        const tips: Tip[] = [s.main, ...s.others]
        body.push(
          <Box key="sk-g-next" flexDirection="column" rowGap={desktop ? 'xs' : 0}>
            <Text dimColor>Best moves right now:</Text>
            {tips.map((t, i) => (
              <Box key={`sk-g-n-${t.command}`} flexDirection="row" alignItems="center" columnGap={1}>
                <Text dimColor>{`${i + 1}.`}</Text>
                <Box flexShrink={0}>
                  <Button key={`sk-tip-${t.command}`} plain onPress={() => void runCommand($, t.command)}>
                    <Text color={i === 0 ? ACCENT : undefined} bold>{nice(t.command)}</Text>
                  </Button>
                </Box>
                <Box flexShrink={1} minWidth={0}>
                  <Text dimColor wrap="truncate-end">{t.why}</Text>
                </Box>
              </Box>
            ))}
          </Box>,
        )
      }
      const shown = new Set<string>()
      for (const g of GROUPS) {
        const items = g.items.filter(([cmd]) => (available.size === 0 || available.has(cmd)) && !shown.has(cmd) && (shown.add(cmd), true))
        if (items.length === 0) continue
        const rows: [string, string][][] = []
        for (let i = 0; i < items.length; i += cols) rows.push(items.slice(i, i + cols))
        body.push(
          <Box key={`sk-g-${g.title}`} flexDirection="column" rowGap={desktop ? 'xs' : 0}>
            <Text bold color={g.color}>{`● ${g.title}`}</Text>
            {rows.map((row, ri) => (
              <Box key={`sk-g-r-${g.title}-${ri}`} flexDirection="row" columnGap={2}>
                {row.map(([cmd, what]) => (
                  <Box key={`sk-g-c-${cmd}`} flexDirection="column" width={cellPct} minWidth={0}>
                    <Button key={`sk-cmd-${cmd}`} plain onPress={() => void runCommand($, cmd)}>
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
        <Box key="sk-g-acts" flexDirection="row" alignItems="center" columnGap={gapS || 1}>
          <Button key="sk-g-close" role="dismiss" label="Close the guide" onPress={() => $.state.set(EXPANDED, false)} />
        </Box>,
      )
      return section('sk-guide', 'COMMAND GUIDE', `Cache ${b.ttlKnown ? (b.ttlMs >= ONE_HOUR ? '1 hour' : '5 min') : '5 min (a guess until the first reply)'} · ${tokenText(b.tokens)} tokens · ${friendlyModel(b.model) || 'model unknown'} · a warm turn ≈ ${money(c.warm)}`, body, '#A78BFA')
    })()

    const notePart = note ? (
      <Box key="sk-note" flexDirection="row" alignItems="center" columnGap={gapS || 1}>
        <Box flexShrink={1} minWidth={0}>
          <Text wrap="wrap">
            <Text color={STATUS.info}>ⓘ </Text>
            <Text dimColor>{note}</Text>
          </Text>
        </Box>
        <Button key="sk-note-x" role="dismiss" label="×" onPress={() => $.state.set(NOTE, '')} />
      </Box>
    ) : null

    // ----- Auto Model's row -----

    const amPart = await (async () => {
      if (!showAm) return null
      const amOn = json['auto-model'] !== false
      const pick = (await $.state.get(AM_PICK)).value
      const live = (await $.state.get(AM_LIVE)).value
      const modes = amModesOf(json, (await $.state.get(AM_MODES)).value, (await $.state.get(AM_OWN)).value)
      const fastLive = live?.fast === true
      const ultraLive = live?.ultracode === true
      const model = amOn && pick ? pick.model : live?.model || b.model
      const why = live?.switching
        ? `Switching to ${friendlyModel(live.switching)}, then your message is sent.`
        : amOn
          ? pick ? `Why: ${pick.why}.` : 'Picks the model and effort each time you send.'
          : 'Off: your own model and effort stay as set.'
      return (
        <Box key="sk-am" flexDirection="column" rowGap={gapS}>
          <Box flexDirection="row" alignItems="center" columnGap={gapS || 1}>
            <Box flexShrink={0}>
              <Text bold color={ACCENT}>◆ Auto Model</Text>
            </Box>
            <Box flexShrink={0}>
              <Button key="sk-am-onoff" variant={amOn ? 'primary' : undefined} label={amOn ? 'ON' : 'OFF'} onPress={() => void toggleAutoModel($, !amOn)} />
            </Box>
            {model ? (
              <Box flexShrink={0}>
                <Text bold color={modelColor(model)}>{`● ${friendlyModel(model)}`}</Text>
              </Box>
            ) : null}
            {amOn && pick ? (
              <Box flexShrink={0}>
                <Text color={effortColor(pick.effort)}>{`${pick.effort} effort`}</Text>
              </Box>
            ) : null}
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">{why}</Text>
            </Box>
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={gapS || 1}>
            <Box flexShrink={0}>
              <Button key="sk-am-fast" variant={fastLive ? 'primary' : undefined} label={amLabel('fast', modes.fast, fastLive)} onPress={() => void cycleAm($, 'fast')} />
            </Box>
            <Box flexShrink={0}>
              <Button key="sk-am-ultra" variant={ultraLive ? 'primary' : undefined} label={amLabel('ultracode', modes.ultracode, ultraLive)} onPress={() => void cycleAm($, 'ultracode')} />
            </Box>
            <Box flexShrink={1} minWidth={0}>
              <Text dimColor size="caption" wrap="truncate-end">Each press: auto → on → off. Auto turns it on when a prompt needs it.</Text>
            </Box>
          </Box>
        </Box>
      )
    })()

    // ----- The panel -----

    const mine: RenderChildren[] = []
    const panelOn = showBar && !hidden

    if (panelOn) {
      const kids: RenderChildren[] = []
      if (holdPart) kids.push(holdPart)

      if (min) {
        // One line: small crab, the grade ring, cache, context, the model, the smart button, + to open.
        const pick = (await $.state.get(AM_PICK)).value
        const model = json['auto-model'] !== false && pick ? pick.model : b.model
        kids.push(
          <Box key="sk-slim" flexDirection="row" alignItems="center" columnGap={gapM || 2}>
            {crab('sk-crab-s', 30)}
            <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
              {ring('sk-r-q-s', gr.score, gr.color, { label: gr.letter })}
              <Text bold color={gr.color}>{String(gr.score)}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text bold color={cacheColor}>{cold ? `❄ cold ${ago(coldMins)}` : b.lastEnd ? `● warm ${mins}m` : '● ready'}</Text>
            </Box>
            <Box flexShrink={0}>
              <Text color={ctxColor}>{`ctx ${Math.round(b.percent)}%`}</Text>
            </Box>
            {b.week !== null ? (
              <Box flexShrink={0}>
                <Text dimColor>{`week ${Math.round(b.week)}%`}</Text>
              </Box>
            ) : null}
            {showAm && model ? (
              <Box flexShrink={0}>
                <Text bold color={modelColor(model)}>{`◆ ${friendlyModel(model)}`}</Text>
              </Box>
            ) : null}
            <Box flexGrow={1} />
            {smart}
            <Box flexShrink={0}>
              <Button key="sk-expand" label="+" onPress={() => $.state.set(MIN, false)} />
            </Box>
          </Box>,
        )
        if (handoffPart) kids.push(handoffPart)
      } else {
        const lead = cold ? 'The cache is cold.' : b.lastEnd && mins <= 2 ? `Cache goes cold in ${mins} min.` : ''
        const tail: Record<string, string> = { compact: 'Compacting now makes later messages cheaper.', handoff: 'A fresh chat with a handoff costs a few cents.', keepwarm: 'Keeping it warm costs a few cents a ping.' }
        const headline = `${lead}${lead ? ' ' : ''}${s ? tail[main] ?? s.main.why : 'Looking good.'}`.trim()

        const marks = (
          <Box key="sk-marks" flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={desktop ? 'lg' : 2}>
            {mark('q', ring('sk-r-q', gr.score, gr.color, { label: gr.letter }), String(gr.score), 'quality', gr.color, hoverCard(`Quality ${gr.letter} · ${gr.score} of 100`, [
              'How well Claude can still work in this chat.',
              'Starts at 100; loses 0.4 per point of context used (more past 70%), 5 per tool error (up to 20), and 4 when the cache is cold on a big chat.',
              'S 90+ · A 80+ · B 70+ · C 55+ · D 40+ · F below.',
            ], 'left'))}
            {mark('c', ring('sk-r-c', b.percent, ctxColor), `${Math.round(b.percent)}%`, 'context', ctxColor, hoverCard(`Context ${Math.round(b.percent)}% full`, [
              winTok ? `${tokenText(b.tokens)} of ${tokenText(winTok)} tokens.` : `${tokenText(b.tokens)} tokens.`,
              'Past about 70% Claude starts losing earlier details. Compact keeps the thread.',
            ], 'left'))}
            {mark('k', ring('sk-r-k', cold || !b.lastEnd ? (cold ? 100 : 0) : (ms / b.ttlMs) * 100, cacheColor, { dashed: cold }), cold ? 'cold' : b.lastEnd ? `${mins}m` : 'ready', 'cache', cacheColor, hoverCard(cold ? `Cache cold for ${ago(coldMins)}` : b.lastEnd ? `Cache warm, ${mins} min left` : 'Cache ready', [
              `Cache length ${b.ttlMs >= ONE_HOUR ? '1 hour' : '5 min'}${b.ttlKnown ? '' : ' (a guess until the first reply)'}.`,
              cold ? `The next message re-reads ${tokenText(b.tokens)} tokens at full price: about ${money(c.rewrite)}.` : `A message now costs about ${money(c.warm)}; once cold, about ${money(c.rewrite)}.`,
            ], 'left'))}
            {b.fiveHour !== null ? mark('f', ring('sk-r-f', b.fiveHour, limColor(b.fiveHour)), `${Math.round(b.fiveHour)}%`, '5 hrs', limColor(b.fiveHour), hoverCard('5-hour limit', [`${Math.round(b.fiveHour)}% of your 5-hour limit used.`, 'It refills on a rolling 5-hour window. /usage shows when.'], 'right')) : null}
            {b.week !== null ? mark('w', ring('sk-r-w', b.week, limColor(b.week)), `${Math.round(b.week)}%`, 'week', limColor(b.week), hoverCard('Weekly limit', [`${Math.round(b.week)}% of this week's limit used.`, '/usage shows when it resets.'], 'right')) : null}
          </Box>
        )
        const headRow = (
          <Box key="sk-head" flexDirection="row" alignItems="center" columnGap={gapM || 2}>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
              <Text wrap="wrap">
                <Text bold color={ACCENT}>Session Keeper </Text>
                <Text>{headline}</Text>
              </Text>
            </Box>
            {smart}
          </Box>
        )
        const wide = width >= 100
        kids.push(
          <Box key="sk-top" flexDirection="row" alignItems="center" columnGap={gapM || 2}>
            <Box flexDirection="row" alignItems="center" columnGap={gapS || 1} flexShrink={0}>
              {crab('sk-crab', 72)}
              <Box flexDirection="column" rowGap={gapS}>
                <Button key="sk-open" label={open ? '▴' : '▾'} onPress={() => $.state.set(EXPANDED, !open)} />
                <Button key="sk-min" label="–" onPress={() => $.state.set(MIN, true)} />
              </Box>
            </Box>
            <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} rowGap={gapM}>
              {headRow}
              {wide ? marks : null}
            </Box>
          </Box>,
        )
        if (!wide) kids.push(marks)

        // Token weather and the facts: text only, so they may wrap.
        const wx = weatherOf(b.percent)
        const bars = hist.slice(-12)
        const delta = hist.length >= 2 ? hist[hist.length - 1]! - hist[hist.length - 2]! : 0
        const openMins = Math.max(0, Math.round((Date.now() - f.startedAt) / 60_000))
        kids.push(
          <Box key="sk-info" flexDirection="column" rowGap={gapS}>
            <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
              <Text bold color={wx.color}>{`${wx.icon} ${wx.word}`}</Text>
              <Text>{`${Math.round(b.percent)}% of context`}</Text>
              <Text dimColor>{winTok ? `${tokenText(b.tokens)} / ${tokenText(winTok)}` : tokenText(b.tokens)}</Text>
              {bars.length >= 2 ? (
                <Text dimColor>
                  last turns <Text color="#EAD23C">{sparkText(bars)}</Text>
                </Text>
              ) : null}
              {hist.length >= 2 ? <Text dimColor>{`${delta >= 0 ? '▲ +' : '▼ −'}${Math.abs(delta).toLocaleString('en-US')} last turn`}</Text> : null}
              <Text dimColor>│</Text>
              <Text dimColor>
                rewrite ≈ <Text bold color={cold ? STATUS.bad : undefined}>{money(c.rewrite)}</Text>
              </Text>
              <Text dimColor>
                session <Text bold>{money(b.sessionUsd)}</Text>
              </Text>
            </Box>
            <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2}>
              <Text dimColor>{`⏱ open ${ago(openMins)}`}</Text>
              <Text dimColor>{`⚒ ${plural(f.tools, 'tool call')}`}</Text>
              <Text dimColor>{`✎ ${plural(f.edits, 'edit')}`}</Text>
              <Text dimColor>{`⟲ ${plural(f.compactions, 'compaction')}`}</Text>
              <Text dimColor>{`↻ ${plural(turns, 'turn')}`}</Text>
              {f.branch ? <Text dimColor>{`⎇ ${f.branch}`}</Text> : null}
            </Box>
          </Box>,
        )

        // The cache in words, then its buttons on their own row, so nothing sits on top of the text.
        kids.push(
          <Box key="sk-cache" flexDirection="column" rowGap={gapS}>
            <Text wrap="wrap">
              <Text color={cacheColor}>{cold ? '❄ ' : '⧖ '}</Text>
              {cold ? (
                <Text>
                  <Text bold color={COLD_BLUE}>{`Cache cold for ${ago(coldMins)}.`}</Text>
                  <Text dimColor>{` Your next message re-reads ${tokenText(b.tokens)} tokens at full price, about ${money(c.rewrite)}.`}</Text>
                </Text>
              ) : (
                <Text>
                  <Text bold color={cacheColor}>{b.lastEnd ? `Cache warm, ${mins} min left.` : 'Cache ready.'}</Text>
                  <Text dimColor>{` A message now costs about ${money(c.warm)}.`}</Text>
                </Text>
              )}
              {warming ? <Text color={STATUS.info}>{` Keeping warm until ${clockTime(warmUntil)}.`}</Text> : null}
            </Text>
            <Box flexDirection="row" alignItems="center" columnGap={gapS || 1}>
              <Button key="sk-handoff" variant={main === 'handoff' || cold ? 'primary' : undefined} label="Hand off to a fresh chat" onPress={() => void startHandoff($)} />
              <Button key="sk-warm" variant={main === 'keepwarm' ? 'primary' : undefined} label={warming ? 'Stop keeping warm' : 'Keep warm'} onPress={() => void (warming ? stopWarm($) : keepWarm($))} />
              <Button key="sk-hide" label="Hide" onPress={() => hide($)} />
            </Box>
          </Box>,
        )
        if (handoffPart) kids.push(handoffPart)
      }

      if (amPart) {
        if (!min) kids.push(rule('sk-rule-am'))
        if (!min) kids.push(amPart)
      }
      if (guidePart) kids.push(guidePart)
      if (notePart) kids.push(notePart)

      mine.push(
        <Box key="sk-panel" flexDirection="column" borderStyle="round" borderColor="#3F3F46" paddingX={padX} paddingY={desktop ? 'sm' : 0} rowGap={gapM}>
          {kids}
        </Box>,
      )
    } else {
      // The panel is hidden or switched off: what still needs an answer is drawn on its own.
      for (const part of [holdPart, handoffPart, guidePart, notePart]) if (part) mine.push(part)
    }

    const rest = await next(e)
    if (mine.length === 0) return rest
    return roomy(<Box flexDirection="column" rowGap={gapS}>{rest}{mine}</Box>, e.surface)
  })
}

// Kept for the help text of commands not in the catalogue.
export const describe = (cmd: string) => DESCRIBE.get(cmd) ?? ''
