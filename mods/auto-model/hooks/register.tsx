// Auto Model (Solomon Mods): sets the best model, effort, Fast mode and ultracode before every prompt.
// - Five tiers: quick, normal, deep, expert, and urgent. Each names a model (Haiku, Sonnet, Opus,
//   Fable) and an effort (low to max). Plain rules read the prompt; no extra model call, no cost.
// - Fast mode turns on by itself when you say it is urgent, and off again after.
// - Ultracode is added to big multi-file code jobs when you switch that part on (it is off at first,
//   because it runs many helpers at once).
// - Changing model makes Claude read the whole chat again at full price. When the chat is long and
//   the cache is warm, Auto Model runs /compact first, so the new model reads a short summary.
// - How it switches: the engine will not run /model, /effort or /compact from inside the prompt
//   hook, so a prompt that needs a new model is held for a moment, the settings are changed, and then
//   your message is sent again by itself. A prompt that needs no switch goes straight through.
// - A chip above the prompt shows the pick, with ON/OFF, Fast and Ultracode switches. /automodel
//   shows it in words.
// The idea is credited in SOURCES.md.

import type { EngineInterface, Register } from 'claude-code'

import type { Pick } from '../types'
import { ACCENT, STATUS, isPartOn, log as suiteLog, partOn, readSwitches, roomy, tokenText, writeSwitches } from './suite'

const NAME = 'auto-model'
const PICK = { plugin: 'auto-model', key: 'pick' } as const
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
let lastEnd = 0
let resend = '' // the message Auto Model put back itself: it passes straight through

const log = ($: EngineInterface, line: string) => suiteLog($, NAME, line)

export function friendly(model: string): string {
  const m = /(haiku|sonnet|opus|fable)[-\s]?(\d+)?(?:[-.](\d+))?/i.exec(model)
  if (!m) return model
  const name = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return m[2] ? `${name} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : name
}

/** One colour per model family, the same everywhere. */
const colorOf = (model: string) => {
  const f = friendly(model)
  return f.startsWith('Haiku') ? '#22C55E' : f.startsWith('Sonnet') ? '#F5A524' : f.startsWith('Fable') ? '#4F7DF3' : ACCENT
}

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
}

/** The switches on the chip: the same ones /mods writes. */
async function togglePart($: EngineInterface, part: 'fast' | 'ultracode') {
  const json = await readSwitches($, true)
  const now = !isPartOn(json, NAME, part)
  await writeSwitches($, { ...json, [`${NAME}:${part}`]: now })
  if (!now && part === 'fast') await setFast($, false)
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
  const useModel = await partOn($, NAME, 'model')
  const useEffort = await partOn($, NAME, 'effort')
  let model = useModel ? (FABLE_RE.test(text) ? MODELS.fable : base.model) : ''
  let eff: Effort | '' = useEffort ? (MAX_RE.test(text) ? 'max' : base.effort) : ''
  const fast = tier === 'urgent' && (await partOn($, NAME, 'fast'))
  if (fast) {
    model = MODELS.opus
    if (eff === 'xhigh' || eff === 'max') eff = 'high'
  }
  const ultra = BIG_CODE_RE.test(text) && !/\bultracode\b/i.test(text) && (await partOn($, NAME, 'ultracode'))
  const before = sessionModel || (await $.session.model().catch(() => ''))
  if (before && !sessionModel) sessionModel = before
  const switching = !!model && !!before && friendly(model) !== friendly(before)
  let why = base.label
  let compact = false
  if (switching) {
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
  return { text: ultra ? `${text}\n\nultracode` : text, model, eff, fast, ultra, tier, why, compact, switching }
}

async function record($: EngineInterface, p: Plan) {
  current = p.model || current
  effort = p.eff
  const pick: Pick = { model: current || sessionModel, effort: (p.eff || 'medium') as Effort, fast: p.fast, ultracode: p.ultra, tier: p.tier, why: p.why, compacted: p.compact, at: Date.now() }
  await $.state.set(PICK, pick)
  await log($, `${sid.slice(0, 8)} ${p.tier}: ${friendly(pick.model)} · ${pick.effort}${p.fast ? ' · fast' : ''}${p.ultra ? ' · ultracode' : ''} (${p.why})`)
}

/** Runs later, outside the prompt hook: compact, switch model, effort and Fast, then send the message again. */
async function applyThenSend($: EngineInterface, p: Plan) {
  try {
    if (p.compact) {
      const r = await $.session.compact({ instructions: 'Keep every decision, open task, file path and next step. The next prompt switches model.' }).catch(async err => (await log($, `compact: ${String(err)}`), null))
      if (!r) p.why += ' · compact did not run'
    }
    if (p.fast !== fastOn) await setFast($, p.fast)
    if (p.model && friendly(p.model) !== friendly(sessionModel)) {
      await run($, 'model', p.model)
      sessionModel = p.model // set even if the command failed, so one failure cannot loop; the request still uses it
    }
    if (p.eff && p.eff !== sessionEffort) {
      await run($, 'effort', p.eff)
      sessionEffort = p.eff
    }
  } catch (err) {
    await log($, `apply: ${String(err)}`)
  }
  await record($, p)
  resend = p.text
  await $.prompt.submit({ text: p.text, asUser: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    sid = await $.session.id().catch(() => '')
    current = ''
    effort = ''
    sessionEffort = ''
    resend = ''
    sessionModel = await $.session.model().catch(() => '')
    lastEnd = 0
    await $.command.register({ name: 'automodel', description: 'Auto Model: what it picked for the last prompt and why' })
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
    // A new model (or Fast mode) has to be set before Claude answers, and the engine only allows that
    // outside this hook: hold the message, change the settings, send it again.
    if (p.switching || p.fast !== fastOn) {
      try {
        $.ui.toast(`◆ Auto Model: ${friendly(p.model || sessionModel)}${p.eff ? `, ${p.eff} effort` : ''}${p.compact ? ', compacting first' : ''}`)
      } catch {
        // Only a hint.
      }
      $.clock.after(1, () => void applyThenSend($, p).catch(err => log($, `send: ${String(err)}`)))
      return { drop: `Auto Model is switching to ${friendly(p.model || sessionModel)}${p.compact ? ' after compacting' : ''}, then sends your message.` }
    }
    await record($, p)
    return next(p.text === e.text ? e : { ...e, text: p.text })
  }).catch(($, e, next) => next(e))

  // Every request of the main chat uses the picked model and effort. Helpers keep their own.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || (!current && !effort)) return yield* next(e)
    return yield* next({ ...e, ...(current ? { model: current } : {}), ...(effort ? { effort } : {}) })
  })

  // Once a reply ends it is safe to run commands: bring the app's effort picker in line, and Fast mode back off.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      lastEnd = await $.clock.now()
      if (fastOn) await setFast($, false)
      if (effort && effort !== sessionEffort) {
        await run($, 'effort', effort)
        sessionEffort = effort
      }
    }
    return r
  })

  on('command.run', { command: 'automodel' }, async $ => {
    const p = (await $.state.get(PICK)).value
    if (!p) return { text: 'Auto Model has not picked yet in this chat. It sets the model and effort when you send a prompt.' }
    return {
      text: [
        `Last prompt was ${p.tier}: ${friendly(p.model)}, ${p.effort} effort${p.fast ? ', Fast mode' : ''}${p.ultracode ? ', ultracode' : ''}.`,
        `Why: ${p.why}.`,
        'Quick questions use Haiku, normal tasks Sonnet, deep and hard work Opus, and Fable when you ask for the best model. Switch any part off in /mods.',
      ].join('\n'),
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const json = await readSwitches($)
    if (!isPartOn(json, NAME, 'chip')) return next(e)
    const isOn = json[NAME] !== false
    const p = (await $.state.get(PICK)).value
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const effortColor = p ? { low: STATUS.good, medium: STATUS.info, high: STATUS.warn, xhigh: ACCENT, max: STATUS.bad }[p.effort] : undefined
    const live = isOn && p
    const fastOk = isPartOn(json, NAME, 'fast')
    const ultraOk = isPartOn(json, NAME, 'ultracode')
    const chip = (
      <Box key="am" flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
          <Box flexShrink={0}><Text bold>Auto Model</Text></Box>
          <Box flexShrink={0}><Button key="am-toggle" variant={isOn ? 'primary' : undefined} label={isOn ? 'ON' : 'OFF'} onPress={() => toggle($, !isOn)} /></Box>
          {live ? <Box flexShrink={0}><Text bold color={colorOf(p.model)}>{`● ${friendly(p.model)} ✓`}</Text></Box> : null}
          {live ? <Box flexShrink={0}><Text color={effortColor}>{`${p.effort} effort`}</Text></Box> : null}
          {isOn ? <Box flexShrink={0}><Button key="am-fast" variant={live && p.fast ? 'primary' : undefined} label={`⚡ Fast${live && p.fast ? ' ON' : fastOk ? '' : ' off'}`} onPress={() => togglePart($, 'fast')} /></Box> : null}
          {isOn ? <Box flexShrink={0}><Button key="am-ultra" variant={live && p.ultracode ? 'primary' : undefined} label={`Ultracode${live && p.ultracode ? ' ON' : ultraOk ? '' : ' off'}`} onPress={() => togglePart($, 'ultracode')} /></Box> : null}
        </Box>
        <Text dimColor wrap="truncate-end">{isOn ? (p ? p.why : 'Sets the model, effort, Fast and ultracode each time you send.') : 'Off: your own model stays as set.'}</Text>
      </Box>
    )
    return roomy(<Box flexDirection="column">{rest}{chip}</Box>, e.surface)
  })
}
