// Auto Model (Solomon Mods): sets the best model, effort, fast mode and Ultracode before every prompt.
// - Five tiers: quick, normal, deep, expert, and urgent. Each names a model (Haiku, Sonnet, Opus,
//   Fable) and an effort (low to max). Plain rules read the prompt; no extra model call, no cost.
// - Fast mode and Ultracode each have three settings for the chat: auto, on, off. Auto turns fast
//   mode on for an urgent ask (and off after), and adds Ultracode to a big multi-file code job.
//   On runs /fast on or /effort ultracode on right away; off keeps it off. The buttons sit in
//   Session Keeper's panel (or on this mod's own chip when that panel is hidden or off).
// - Changing model makes Claude read the whole chat again at full price. When the chat is long and
//   the cache is warm, Auto Model runs /compact first, so the new model reads a short summary.
// - How it switches: the engine will not run /model, /effort or /compact from inside the prompt
//   hook, so a prompt that needs a new model is held for a moment, the settings are changed, and then
//   your message is sent again by itself. A prompt that needs no switch goes straight through.
// - /automodel says what it picked and why.
// The idea is credited in SOURCES.md.

import type { EngineInterface, Register } from 'claude-code'

import type { Live, Pick } from '../types'
import {
  ACCENT,
  amLabel,
  amModesOf,
  effortColor,
  friendlyModel,
  isPartOn,
  log as suiteLog,
  modelColor,
  nextAmMode,
  partOn,
  readSwitches,
  roomy,
  runAmCommand,
  tokenText,
  writeSwitches,
} from './suite'
import type { AmFeature, AmModes } from './suite'

const NAME = 'auto-model'
const PICK = { plugin: 'auto-model', key: 'pick' } as const
const LIVE = { plugin: 'auto-model', key: 'live' } as const
const MODES = { plugin: 'auto-model', key: 'modes' } as const
// Session Keeper's values: read only.
const SK_HOSTING = { plugin: 'session-keeper', key: 'hosting' } as const
const SK_MODES = { plugin: 'session-keeper', key: 'amModes' } as const
const MODELS = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' }
const COMPACT_OVER = 40_000
const FIVE_MIN = 5 * 60_000

type Tier = 'quick' | 'normal' | 'deep' | 'expert' | 'urgent'
type Effort = Pick['effort']

const PLAN: Record<Tier, { model: string; effort: Effort; label: string }> = {
  quick: { model: MODELS.haiku, effort: 'low', label: 'a quick question' },
  normal: { model: MODELS.sonnet, effort: 'medium', label: 'a normal task' },
  deep: { model: MODELS.opus, effort: 'high', label: 'deep work' },
  expert: { model: MODELS.opus, effort: 'xhigh', label: 'a hard, high-stakes job' },
  urgent: { model: MODELS.opus, effort: 'medium', label: 'something urgent' },
}

let sid = ''
let current = '' // the model this chat's requests use
let effort: Effort | '' = ''
let sessionModel = '' // what the app's own model picker shows
let sessionEffort = ''
let fastOn = false
let ultraOn = false
let fastBroken = false // /fast failed in this chat: stop asking for it, so messages are not held for nothing
let switching = ''
let lastEnd = 0
let resend = '' // the message Auto Model put back itself: it passes straight through

const log = ($: EngineInterface, line: string) => suiteLog($, NAME, line)

export const friendly = friendlyModel

const MAX_RE = /\b(ultrathink|think (as )?hard(er)?|max(imum)? effort|as carefully as (you )?can|no mistakes)\b/i
const EXPERT_RE = /\b(architect\w*|system design|security (review|audit)|legal|contract|tax|financial model|valuation|due diligence|strategy|migrat\w*|root cause|production (bug|outage|incident))\b/i
const DEEP_RE =
  /\b(plan|planning|design (?:a|the) (?:system|app|database)|build (?:a|an|the) \w+|refactor\w*|debug\w*|investigat\w*|research\w*|analy[sz]\w*|audit\w*|proposal|business plan|forecast\w*|compare (?:the )?options|trade-?offs?|step by step|in depth|deep dive)\b/i
const QUICK_RE = /^(what|what's|whats|when|where|who|which|how much|how many|is|are|can|could|does|do|did|define|quick question|remind me)\b/i
const ACT_RE = /\b(write|edit|change|fix|create|make|add|remove|update|build|run|send|draft|rename|move|install|deploy)\b/i
const URGENT_RE = /\b(urgent|asap|right now|quickly|hurry|fast as you can|in a rush|emergency)\b/i
const BIG_CODE_RE = /\b(whole (codebase|repo|app)|every file|across (the )?(codebase|repo|project)|all (the )?(files|modules|mods)|rewrite (the|this) (app|codebase)|migrate (the|this) (app|codebase))\b/i
const FABLE_RE = /\b(fable|best model|smartest model|most capable)\b/i

export function tierOf(text: string): Tier {
  const t = text.trim()
  const words = t.split(/\s+/).filter(Boolean).length
  const asks = (t.match(/\?|\n\s*[-*\d]+[.)]?\s/g) ?? []).length
  if (URGENT_RE.test(t)) return 'urgent'
  if (EXPERT_RE.test(t) || words > 400) return 'expert'
  if (words > 150 || DEEP_RE.test(t) || asks >= 4) return 'deep'
  if (words <= 15 && QUICK_RE.test(t) && !ACT_RE.test(t)) return 'quick'
  return 'normal'
}

async function isWarm($: EngineInterface) {
  if (!lastEnd) return false
  return (await $.clock.now()) - lastEnd < FIVE_MIN
}

/** Tells Session Keeper's panel what is on now. */
async function writeLive($: EngineInterface) {
  const live: Live = { installed: true, fast: fastOn, ultracode: ultraOn, model: sessionModel, switching }
  await $.state.set(LIVE, live)
}

/** This chat's fast mode and Ultracode settings: the newest choice on either panel, else the /mods default. */
async function modesNow($: EngineInterface): Promise<AmModes> {
  const json = await readSwitches($)
  return amModesOf(json, (await $.state.get(SK_MODES)).value, (await $.state.get(MODES)).value)
}

/** Runs one of Claude Code's own commands. Only call it from a later event, never inside prompt.submit. */
async function run($: EngineInterface, command: string, args: string) {
  try {
    await $.command.run({ command, args })
    return true
  } catch (err) {
    await log($, `/${command} ${args}: ${String(err)}`)
    return false
  }
}

async function setFast($: EngineInterface, on: boolean) {
  if (fastOn === on) return
  if (await run($, 'fast', on ? 'on' : 'off')) fastOn = on
  else if (on) fastBroken = true
  await writeLive($)
}

/** One press of the chip's fast mode or Ultracode button: auto → on → off → auto. */
async function cycle($: EngineInterface, f: AmFeature) {
  const cur = await modesNow($)
  const mode = nextAmMode(cur[f])
  await $.state.set(MODES, { ...cur, [f]: mode, at: Date.now() })
  const liveOn = f === 'fast' ? fastOn : ultraOn
  let said = ''
  if (mode === 'on' && !liveOn) said = await runAmCommand($, f, true)
  else if (mode !== 'on' && liveOn) said = await runAmCommand($, f, false)
  try {
    $.ui.toast(`${f === 'fast' ? 'Fast mode' : 'Ultracode'}: ${mode}${said ? ` · ${said.slice(0, 80)}` : ''}`)
  } catch {
    // Only a hint.
  }
}

async function toggle($: EngineInterface, value: boolean) {
  const json = await readSwitches($, true)
  await writeSwitches($, { ...json, [NAME]: value })
  if (!value) {
    current = ''
    effort = ''
  }
}

type Plan = { text: string; model: string; eff: Effort | ''; fast: boolean; ultra: boolean; tier: Tier; why: string; compact: boolean; switching: boolean }

/** Reads the prompt and decides the settings for it. Changes nothing. */
async function planFor($: EngineInterface, text: string): Promise<Plan> {
  const tier = tierOf(text)
  const base = PLAN[tier]
  const modes = await modesNow($)
  const useModel = await partOn($, NAME, 'model')
  const useEffort = await partOn($, NAME, 'effort')
  let model = useModel ? (FABLE_RE.test(text) ? MODELS.fable : base.model) : ''
  let eff: Effort | '' = useEffort ? (MAX_RE.test(text) ? 'max' : base.effort) : ''
  // Fast mode: always when it is on for the chat; for an urgent ask when it is on auto.
  const fast = !fastBroken && (modes.fast === 'on' || (modes.fast === 'auto' && tier === 'urgent'))
  if (fast) {
    // Fast mode runs on Opus.
    if (useModel && model !== MODELS.fable) model = MODELS.opus
    if (eff === 'xhigh' || eff === 'max') eff = 'high'
  }
  // Ultracode on auto rides along on a big multi-file code job; when it is on, the chat already has it.
  const ultra = modes.ultracode === 'auto' && !ultraOn && BIG_CODE_RE.test(text) && !/\bultracode\b/i.test(text)
  const before = sessionModel || (await $.session.model().catch(() => ''))
  if (before && !sessionModel) sessionModel = before
  const isSwitch = !!model && !!before && friendlyModel(model) !== friendlyModel(before)
  let why = base.label
  if (fast) why += ' · fast mode'
  if (ultra) why += ' · Ultracode for a big code job'
  let compact = false
  if (isSwitch) {
    const u = await $.session.usage().catch(() => null)
    const tokens = u?.context.tokens ?? 0
    if (tokens > COMPACT_OVER) {
      if (await isWarm($)) {
        compact = await partOn($, NAME, 'compact')
        why += compact ? ` · compacting ${tokenText(tokens)} tokens first so the switch is cheap` : ` · switching with ${tokenText(tokens)} tokens read once`
      } else {
        why += ' · the cache is cold, so switching costs nothing extra'
      }
    }
  }
  return { text: ultra ? `${text}\n\nultracode` : text, model, eff, fast, ultra, tier, why, compact, switching: isSwitch }
}

async function record($: EngineInterface, p: Plan) {
  current = p.model || current
  effort = p.eff
  const pick: Pick = { model: current || sessionModel, effort: (p.eff || 'medium') as Effort, fast: p.fast, ultracode: p.ultra || ultraOn, tier: p.tier, why: p.why, compacted: p.compact, at: Date.now() }
  await $.state.set(PICK, pick)
  await log($, `${sid.slice(0, 8)} ${p.tier}: ${friendlyModel(pick.model)} · ${pick.effort}${p.fast ? ' · fast' : ''}${pick.ultracode ? ' · ultracode' : ''} (${p.why})`)
}

/** Runs later, outside the prompt hook: compact, then model, fast mode and effort, then sends the message again. */
async function applyThenSend($: EngineInterface, p: Plan) {
  try {
    if (p.compact) {
      const r = await $.session.compact({ instructions: 'Keep every decision, open task, file path and next step. The next prompt switches model.' }).catch(async err => (await log($, `compact: ${String(err)}`), null))
      if (!r) p.why += ' · compact did not run'
    }
    // The model first: switching model turns fast mode off, so fast mode comes after it.
    if (p.model && friendlyModel(p.model) !== friendlyModel(sessionModel)) {
      if (await run($, 'model', p.model)) fastOn = false
      sessionModel = p.model // set even if the command failed, so one failure cannot loop; the request still uses it
    }
    if (p.fast !== fastOn) await setFast($, p.fast)
    // An effort level would replace Ultracode, which is an effort setting of its own.
    if (p.eff && p.eff !== sessionEffort && !ultraOn) {
      await run($, 'effort', p.eff)
      sessionEffort = p.eff
    }
  } catch (err) {
    await log($, `apply: ${String(err)}`)
  }
  switching = ''
  await writeLive($)
  await record($, p)
  resend = p.text
  await $.prompt.submit({ text: p.text, asUser: true })
}

/** "on", "off", or "" from what a command was given or printed. */
const onOff = (args: string, said: string): '' | 'on' | 'off' => {
  const a = args.trim().toLowerCase()
  if (/\b(on|enable|enabled|true)\b/.test(a)) return 'on'
  if (/\b(off|disable|disabled|false)\b/.test(a)) return 'off'
  if (/\b(on|enabled)\b/i.test(said)) return 'on'
  if (/\b(off|disabled)\b/i.test(said)) return 'off'
  return ''
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    sid = await $.session.id().catch(() => '')
    current = ''
    effort = ''
    sessionEffort = ''
    resend = ''
    switching = ''
    fastBroken = false
    sessionModel = await $.session.model().catch(() => '')
    lastEnd = 0
    const prev = (await $.state.get(LIVE)).value
    fastOn = prev?.fast === true
    ultraOn = prev?.ultracode === true
    await writeLive($)
    await $.command.register({ name: 'automodel', description: 'Auto Model: what it picked for the last prompt and why' })
    return r
  })

  // Keeps track of fast mode, Ultracode, model and effort, whoever changes them. When you type
  // /fast or /effort ultracode yourself, that becomes this chat's setting.
  on('command.run', { command: 'fast' }, async ($, e, next) => {
    const r = await next(e)
    const v = onOff(e.args, String(r.text ?? ''))
    if (v) {
      fastOn = v === 'on'
      if (e.origin.kind !== 'plugin') await $.state.set(MODES, { ...(await modesNow($)), fast: v, at: Date.now() })
      await writeLive($)
    }
    return r
  })
  on('command.run', { command: 'effort' }, async ($, e, next) => {
    const r = await next(e)
    const a = e.args.trim().toLowerCase()
    if (a.startsWith('ultracode')) {
      const v = onOff(a.slice('ultracode'.length), String(r.text ?? ''))
      if (v) {
        ultraOn = v === 'on'
        if (e.origin.kind !== 'plugin') await $.state.set(MODES, { ...(await modesNow($)), ultracode: v, at: Date.now() })
      }
    } else if (/^(low|medium|high|xhigh|max)\b/.test(a)) {
      sessionEffort = a.split(/\s+/)[0] ?? sessionEffort
    }
    await writeLive($)
    return r
  })
  on('command.run', { command: 'model' }, async ($, e, next) => {
    const r = await next(e)
    const now = await $.session.model().catch(() => '')
    if (now && friendlyModel(now) !== friendlyModel(sessionModel)) {
      sessionModel = now
      fastOn = false
      if (e.origin.kind !== 'plugin') current = '' // your own pick wins until the next prompt
    }
    await writeLive($)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const person = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (!person || e.command || e.isMeta || !(await partOn($, NAME))) return next(e)
    if (resend && e.text === resend) {
      resend = ''
      return next(e)
    }
    let p: Plan
    try {
      p = await planFor($, e.text)
    } catch (err) {
      await log($, `plan: ${String(err)}`)
      return next(e)
    }
    // A new model (or fast mode) has to be set before Claude answers, and the engine only allows that
    // outside this hook: hold the message, change the settings, send it again.
    if (p.switching || p.fast !== fastOn) {
      switching = p.model || sessionModel
      await writeLive($)
      try {
        $.ui.toast(`◆ Auto Model: ${friendlyModel(p.model || sessionModel)}${p.eff ? `, ${p.eff} effort` : ''}${p.fast ? ', fast mode' : ''}${p.compact ? ', compacting first' : ''}`)
      } catch {
        // Only a hint.
      }
      $.clock.after(1, () => void applyThenSend($, p).catch(err => log($, `send: ${String(err)}`)))
      return { drop: `Auto Model is switching to ${friendlyModel(p.model || sessionModel)}${p.compact ? ' after compacting' : ''}, then sends your message.` }
    }
    await record($, p)
    return next(p.text === e.text ? e : { ...e, text: p.text })
  }).catch(($, e, next) => next(e))

  // Every request of the main chat uses the picked model and effort. Helpers keep their own.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || (!current && !effort)) return yield* next(e)
    if (!(await partOn($, NAME))) {
      current = ''
      effort = ''
      return yield* next(e)
    }
    return yield* next({ ...e, ...(current ? { model: current } : {}), ...(effort && !ultraOn ? { effort } : {}) })
  })

  // Once a reply ends it is safe to run commands: fast mode on auto goes back off, and the app's
  // effort picker is brought in line (unless Ultracode is on, which is an effort setting itself).
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      lastEnd = await $.clock.now()
      const modes = await modesNow($)
      if (fastOn && modes.fast === 'auto') await setFast($, false)
      if (effort && effort !== sessionEffort && !ultraOn && (await partOn($, NAME))) {
        await run($, 'effort', effort)
        sessionEffort = effort
      }
    }
    return r
  })

  on('command.run', { command: 'automodel' }, async $ => {
    const p = (await $.state.get(PICK)).value
    const m = await modesNow($)
    const modesLine = `Fast mode: ${m.fast}${fastOn ? ' (on now)' : ''}. Ultracode: ${m.ultracode}${ultraOn ? ' (on now)' : ''}. Auto turns them on when a prompt calls for it.`
    if (!p) return { text: `Auto Model has not picked yet in this chat. It sets the model and effort when you send a prompt.\n${modesLine}` }
    return {
      text: [
        `Last prompt was ${p.tier}: ${friendlyModel(p.model)}, ${p.effort} effort${p.fast ? ', fast mode' : ''}${p.ultracode ? ', Ultracode' : ''}.`,
        `Why: ${p.why}.`,
        modesLine,
        'Quick questions use Haiku, normal tasks Sonnet, deep and hard work Opus, and Fable when you ask for the best model. Switch any part off in /mods.',
      ].join('\n'),
    }
  })

  // The chip: drawn only when Session Keeper's panel is not showing Auto Model's row.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const json = await readSwitches($)
    if (!isPartOn(json, NAME, 'chip') || (await $.state.get(SK_HOSTING)).value === true) return next(e)
    const isOn = json[NAME] !== false
    const p = (await $.state.get(PICK)).value
    const modes = amModesOf(json, (await $.state.get(SK_MODES)).value, (await $.state.get(MODES)).value)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const desktop = e.surface === 'desktop' || e.surface === 'mobile'
    const gap = desktop ? 'sm' : 1
    const live = isOn && p
    const chip = (
      <Box key="am" flexDirection="column" rowGap={desktop ? 'sm' : 0}>
        <Box flexDirection="row" alignItems="center" columnGap={gap}>
          <Box flexShrink={0}><Text bold color={ACCENT}>◆ Auto Model</Text></Box>
          <Box flexShrink={0}><Button key="am-toggle" variant={isOn ? 'primary' : undefined} label={isOn ? 'ON' : 'OFF'} onPress={() => toggle($, !isOn)} /></Box>
          {live ? <Box flexShrink={0}><Text bold color={modelColor(p.model)}>{`● ${friendlyModel(p.model)}`}</Text></Box> : null}
          {live ? <Box flexShrink={0}><Text color={effortColor(p.effort)}>{`${p.effort} effort`}</Text></Box> : null}
          <Box flexShrink={1} minWidth={0}>
            <Text dimColor wrap="truncate-end">{isOn ? (p ? p.why : 'Sets the model and effort each time you send.') : 'Off: your own model stays as set.'}</Text>
          </Box>
        </Box>
        <Box flexDirection="row" alignItems="center" columnGap={gap}>
          <Box flexShrink={0}><Button key="am-fast" variant={fastOn ? 'primary' : undefined} label={amLabel('fast', modes.fast, fastOn)} onPress={() => cycle($, 'fast')} /></Box>
          <Box flexShrink={0}><Button key="am-ultra" variant={ultraOn ? 'primary' : undefined} label={amLabel('ultracode', modes.ultracode, ultraOn)} onPress={() => cycle($, 'ultracode')} /></Box>
          <Box flexShrink={1} minWidth={0}><Text dimColor wrap="truncate-end">Each press: auto → on → off.</Text></Box>
        </Box>
      </Box>
    )
    return roomy(<Box flexDirection="column">{rest}{chip}</Box>, e.surface)
  })
}
