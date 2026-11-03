// Auto Model (Solomon Mods): sets the best model, effort, Fast mode and ultracode before every prompt.
// - Five tiers: quick, normal, deep, expert, and urgent. Each names a model (Haiku, Sonnet, Opus,
//   Fable) and an effort (low to max). Plain rules read the prompt; no extra model call, no cost.
// - Fast mode turns on by itself when you say it is urgent, and off again after.
// - Ultracode is added to big multi-file code jobs when you switch that part on (it is off at first,
//   because it runs many helpers at once).
// - Changing model makes Claude read the whole chat again at full price. When the chat is long and
//   the cache is warm, Auto Model runs /compact first, so the new model reads a short summary.
// - A chip above the prompt shows the pick and the reason. /automodel shows it in words.
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
let current = ''
let effort: Effort | '' = ''
let fastOn = false
let lastEnd = 0
let appliedEffort = ''

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

async function setFast($: EngineInterface, on: boolean) {
  if (fastOn === on) return
  try {
    await $.command.run({ command: 'fast', args: on ? 'on' : 'off' })
    fastOn = on
  } catch (err) {
    await log($, `fast ${on}: ${String(err)}`)
  }
}

/** Runs /model or /effort, so the app's own model and effort change before Claude answers. */
async function applySetting($: EngineInterface, command: 'model' | 'effort', args: string) {
  try {
    await $.command.run({ command, args })
  } catch (err) {
    await log($, `${command} ${args}: ${String(err)}`)
  }
}

/** The ON/OFF switch on the chip: writes the same switch /mods uses. */
async function toggle($: EngineInterface, value: boolean) {
  const json = await readSwitches($, true)
  await writeSwitches($, { ...json, [NAME]: value })
  if (!value) {
    current = ''
    effort = ''
  }
}

/** Decides the settings for this prompt and returns the text to send (ultracode may be added). */
async function choose($: EngineInterface, text: string): Promise<string> {
  const tier = tierOf(text)
  const plan = PLAN[tier]
  const useModel = await partOn($, NAME, 'model')
  const useEffort = await partOn($, NAME, 'effort')
  let model = useModel ? (FABLE_RE.test(text) ? MODELS.fable : plan.model) : ''
  let eff: Effort | '' = useEffort ? (MAX_RE.test(text) ? 'max' : plan.effort) : ''
  const fast = tier === 'urgent' && (await partOn($, NAME, 'fast'))
  const ultra = BIG_CODE_RE.test(text) && !/\bultracode\b/i.test(text) && (await partOn($, NAME, 'ultracode', false))
  const before = current || (await $.session.model().catch(() => ''))
  let compacted = false
  let why = `${plan.label}`
  if (model && friendly(model) !== friendly(before) && before) {
    const u = await $.session.usage().catch(() => null)
    const tokens = u?.context.tokens ?? 0
    if (tokens > COMPACT_OVER && (await isWarm($))) {
      if (await partOn($, NAME, 'compact')) {
        const r = await $.session.compact({ instructions: 'Keep every decision, open task, file path and next step. The next prompt switches model.' }).catch(async err => (await log($, `compact: ${String(err)}`), null))
        compacted = !!r && !('skip' in r && r.skip)
        why += compacted ? ` · compacted ${tokenText(tokens)} tokens first so the switch is cheap` : ''
      }
      if (!compacted && tokens > 150_000) {
        why += ` · kept ${friendly(before)}: switching now would re-read ${tokenText(tokens)} tokens. Run /compact to switch`
        model = ''
      } else if (!compacted) {
        why += ` · switched without compacting (${tokenText(tokens)} tokens read once)`
      }
    }
  }
  if (fast) {
    model = MODELS.opus
    if (eff === 'xhigh' || eff === 'max') eff = 'high'
  }
  await setFast($, fast)
  if (model && friendly(model) !== friendly(before)) await applySetting($, 'model', model)
  if (eff && eff !== appliedEffort) {
    await applySetting($, 'effort', eff)
    appliedEffort = eff
  }
  current = model || current
  effort = eff
  const pick: Pick = { model: current || before, effort: (eff || 'medium') as Effort, fast, ultracode: ultra, tier, why, compacted, at: Date.now() }
  await $.state.set(PICK, pick)
  await log($, `${sid.slice(0, 8)} ${tier}: ${friendly(pick.model)} · ${pick.effort}${fast ? ' · fast' : ''}${ultra ? ' · ultracode' : ''} (${why})`)
  return ultra ? `${text}\n\nultracode` : text
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    sid = await $.session.id().catch(() => '')
    current = ''
    effort = ''
    appliedEffort = ''
    lastEnd = 0
    await $.command.register({ name: 'automodel', description: 'Auto Model: what it picked for the last prompt and why' })
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const person = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (!person || e.command || e.isMeta || !(await partOn($, NAME))) return next(e)
    const text = await choose($, e.text).catch(async err => (await log($, `choose: ${String(err)}`), e.text))
    return next(text === e.text ? e : { ...e, text })
  }).catch(($, e, next) => next(e))

  // Every request of the main chat uses the picked model and effort. Helpers keep their own.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined || (!current && !effort)) return yield* next(e)
    return yield* next({ ...e, ...(current ? { model: current } : {}), ...(effort ? { effort } : {}) })
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) {
      lastEnd = await $.clock.now()
      if (fastOn) await setFast($, false)
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
    const chip = (
      <Box key="am" flexDirection="row" columnGap={1} alignItems="center">
        <Text bold>Auto Model</Text>
        <Button key="am-toggle" variant={isOn ? 'primary' : undefined} label={isOn ? 'ON' : 'OFF'} onPress={() => toggle($, !isOn)} />
        {live ? <Text bold color={colorOf(p.model)}>{`● ${friendly(p.model)} ✓`}</Text> : null}
        {live ? <Text color={effortColor}>{`${p.effort} effort`}</Text> : null}
        {live && p.fast ? <Text color={STATUS.warn}>⚡ Fast</Text> : null}
        {live && p.ultracode ? <Text color={STATUS.info}>ultracode</Text> : null}
        <Text dimColor wrap="truncate-end">{isOn ? (p ? `· ${p.why}` : '· sets the model, effort and Fast mode each time you send') : '· off: your own model stays as set'}</Text>
      </Box>
    )
    return roomy(<Box flexDirection="column">{rest}{chip}</Box>, e.surface)
  })
}
