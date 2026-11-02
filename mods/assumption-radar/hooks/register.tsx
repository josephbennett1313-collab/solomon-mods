// Assumption Radar (Solomon Mods): what Claude decided or assumed without being told.
// - Critical decisions (Mucida's Critical Decisions, MIT): Claude records choices you would likely
//   want to rethink; they stay above the prompt with Rethink and Not critical. Its detection
//   rules, prompts and /critical-areas learning are kept as they were, renamed for this suite.
// - Assumption check (the AI Labs idea): at the end of a task Claude lists the assumptions it
//   made. You Tab through them, mark each right or wrong, and the wrong ones go back to Claude.

import type { EngineInterface, Register } from 'claude-code'

import type { Assumption, Decision, Level } from '../types'
import { GRADIENT, MARK, STATUS, cut, isOn, isPartOn, oneLine, readSwitches, roomy, ACCENT } from './suite'

const PLUGIN = 'assumption-radar'
const DECISION_TOOL = `mcp__${PLUGIN}__record_decision`
const SAVE_TOOL = `mcp__${PLUGIN}__save_critical_areas`
const ASSUME_TOOL = `mcp__${PLUGIN}__list_assumptions`
const PENDING = { plugin: 'assumption-radar', key: 'pending' } as const
const ASSUMPTIONS = { plugin: 'assumption-radar', key: 'assumptions' } as const
const NOTICE = { plugin: 'assumption-radar', key: 'notice' } as const

export type Area = { name: string; keywords: string[]; paths: string[] }
export type Config = { description: string; areas: Area[] }
type Learned = { area: string; decision: string }
const LEARNED_MAX = 10
const MAX_ASSUMPTIONS = 6

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const BAND_ROWS = 3
const CLEAR = new Set(['clear', 'reset', 'limpar', 'apagar', 'borrar'])

const storeKey = (cwd: string) => `config:${cwd}`
const noticeKey = (cwd: string) => `notice-seen:${cwd}`
const learnedKey = (cwd: string) => `learned:${cwd}`

const parts = { on: true, decisions: true, assumptions: true, nudge: true }

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')
}

export function globToRegExp(glob: string): RegExp {
  let g = glob.trim().replace(/^\.\//, '')
  if (g.endsWith('/')) g += '**'
  const body = g
    .split('**')
    .map(part => part.split('*').map(escapeRe).join('[^/]*'))
    .join('.*')
  return new RegExp(`(^|/)${body}$`, 'i')
}

export function keywordRegExp(word: string): RegExp {
  const w = escapeRe(word.trim())
  const start = /^\w/.test(word.trim()) ? '\\b' : ''
  return new RegExp(`${start}${w}`, 'i')
}

function editedText(input: Record<string, unknown>): string {
  const out: string[] = []
  for (const k of ['new_string', 'content', 'new_source']) if (typeof input[k] === 'string') out.push(input[k] as string)
  if (Array.isArray(input.edits)) for (const ed of input.edits as Record<string, unknown>[]) if (typeof ed?.new_string === 'string') out.push(ed.new_string)
  return out.join('\n')
}

function watchedText(tool: string, input: Record<string, unknown>): string | undefined {
  if (EDIT_TOOLS.has(tool)) return editedText(input)
  if (tool === 'Bash') return String(input.command ?? '')
  if (tool.startsWith('mcp__') && !tool.startsWith(`mcp__${PLUGIN}__`)) {
    const { tool: _t, ...rest } = input
    return JSON.stringify(rest)
  }
  return undefined
}

export function touchedAreas(config: Config | undefined, tool: string, input: Record<string, unknown>): string[] {
  if (!config) return []
  const text = watchedText(tool, input)
  if (text === undefined) return []
  const path = EDIT_TOOLS.has(tool) ? String(input.file_path ?? input.notebook_path ?? '') : ''
  const hits: string[] = []
  for (const a of config.areas) {
    const byPath = path !== '' && a.paths.some(p => p && globToRegExp(p).test(path))
    const byWord = text !== '' && a.keywords.some(k => k && keywordRegExp(k).test(text))
    if (byPath || byWord) hits.push(a.name)
  }
  return hits
}

const EXTRACT_SYSTEM = `You turn a person's description of what is critical in their project into detection rules for an AI agent working on it. The project may be code, writing (articles, books, docs), data or anything else.
Answer with JSON only, no prose, no code fence:
{"areas":[{"name":"short_snake_case","keywords":["identifier or term"],"paths":["glob"]}]}
- 1 to 8 areas.
- keywords: identifiers, names, commands or domain terms likely to appear in the text, code or commands that touch the area (e.g. "unit_price", "git push", "publish"). Prefer specific terms over common words. Up to 12 per area.
- paths: globs relative to the project root (e.g. "src/billing/**", "**/*.sql", "drafts/"). Only when the description names or implies files or folders; otherwise [].
- The description may be in any language. Area names in English snake_case; keywords as they would appear in the work.
- Never invent identifiers the description gives no hint of.`

export function areasFrom(list: unknown): Area[] | undefined {
  if (!Array.isArray(list)) return undefined
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => (x as string).trim()) : [])
  const areas = list
    .map((a: any) => ({ name: String(a?.name ?? '').trim(), keywords: strs(a?.keywords), paths: strs(a?.paths) }))
    .filter(a => a.name && (a.keywords.length || a.paths.length))
  return areas.length ? areas : undefined
}

export function parseAreas(text: string): Area[] | undefined {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return undefined
  try {
    return areasFrom((JSON.parse(m[0]) as { areas?: unknown }).areas)
  } catch {
    return undefined
  }
}

function describeConfig(c: Config | undefined, learned: Learned[]): string {
  const lines = c
    ? [
        `Critical in this project: "${c.description}"`,
        ...c.areas.map(a => {
          const bits = [a.keywords.length ? `keywords: ${a.keywords.join(', ')}` : '', a.paths.length ? `paths: ${a.paths.join(', ')}` : '']
          return `• ${a.name}: ${bits.filter(Boolean).join(' · ')}`
        }),
        '',
        '/critical-areas <text> or /critical-areas auto replaces it · /critical-areas clear removes it',
      ]
    : [
        'Default protection: Claude records decisions it makes without being asked that you would likely want to undo or rethink.',
        'Nothing specific to this project yet. To make it yours:',
        '  /critical-areas auto   Claude proposes areas from what it knows of this project',
        '  /critical-areas <your words>, e.g. /critical-areas pricing and tax rules, anything in src/billing',
      ]
  if (learned.length) lines.push('', `Marked as not critical (${learned.length}/${LEARNED_MAX}):`, ...learned.map(l => `• (${l.area}) ${l.decision}`))
  return lines.join('\n')
}

const DEFAULT_CRITERIA = [
  'Record a decision only when the user would likely want to undo or rethink it if they saw it. When in doubt, do not record. Usually a task has none or one.',
  'It qualifies when you made it on your own, without the user asking for it literally, and it:',
  '- adds, removes or swaps something the user did not ask for: a topic, source, claim, comparison, feature, dependency or step;',
  '- picks a value, rule, formula, default, structure or schema the user did not specify, where another reasonable choice existed;',
  "- departs from or works around the user's instructions, or the project's own instructions you were given (such as CLAUDE.md);",
  '- is hard to undo or reaches outside this session: deleting, overwriting, publishing, sending, deploying, migrating data, spending money;',
  '- fills a gap in the request with an assumption that changes the result.',
  'A choice the user left to you ("you decide", "pick one") still qualifies when it changes the result: they delegated it, so tell them what you picked.',
  "Not critical: naming, wording and formatting, refactors that keep behaviour, steps that follow directly from the request, and choices that follow the project's conventions.",
  'Group related choices into one record. Judge what matters with what you know of this project, its instructions included.',
  'level "undo" when the user may well want it taken back (it changes scope, a rule or the result, or is hard to undo); "know" when it is a reasonable choice they should just be aware of.',
].join('\n')

const ASSUME_SECTION = [
  '# Assumption check',
  'When you finish a task that produced or changed something (files, a document, a plan, numbers), call list_assumptions once, right before your final reply, with the assumptions the result rests on that the user did not state: facts you guessed, defaults you filled in, how you read an unclear ask, sources you trusted.',
  `Up to ${MAX_ASSUMPTIONS}, most consequential first, each one plain sentence the user can mark right or wrong. Skip it for questions, chat, or tiny edits with nothing assumed. Do not repeat what you recorded with record_decision.`,
].join('\n')

export function systemSection(c: Config | undefined, learned: Learned[], withAssumptions: boolean, withDecisions: boolean): string {
  const out: string[] = []
  if (withDecisions) {
    const marked = c
      ? [`The user also marked these as critical in this project: "${c.description}".`, `Areas: ${c.areas.map(a => a.name).join(', ')}. A decision of yours that touches them qualifies even when small.`]
      : ['The user has not said what is critical in this project, so these defaults are all there is.']
    const taught = learned.length ? ['The user marked these earlier records as not critical; do not record their like:', ...learned.map(l => `- (${l.area}) ${l.decision}`)] : []
    out.push(
      '# Critical decisions',
      DEFAULT_CRITERIA,
      ...marked,
      ...taught,
      'When a decision qualifies, call the record_decision tool with it, the reason, the alternative you ruled out and its level, before your final reply, then mention it in the reply. Listing it only in your reply is not enough: the user sees what you record.',
    )
  }
  if (withAssumptions) out.push(ASSUME_SECTION)
  return out.join('\n')
}

function writeNudge(): string {
  return `[${PLUGIN}] If what you just wrote carries a choice the user did not make (a value, rule, scope or assumption that changes the result, including one they left to you), call ${DECISION_TOOL} now, before your reply; a decision told only in prose does not reach the user. Otherwise ignore this.`
}

function reminder(areas: string[]): string {
  return `[${PLUGIN}] You touched what the user marked as critical (${areas.join(', ')}). If this was your own decision, not something the user literally asked for, call ${DECISION_TOOL} with the decision, the reason and the alternative you ruled out, and say so in your reply. If it was asked for literally, carry on without recording.`
}

const LEVEL_LABEL: Record<Level, string> = { undo: 'to rethink', know: 'to know' }

function report(list: Decision[]): string {
  if (!list.length) return 'No critical decisions recorded in this session.'
  return list.map((d, i) => `${i + 1}. [${d.time}] ${LEVEL_LABEL[d.level]} (${d.area}) ${d.decision}\n   because: ${d.reason}\n   ruled out: ${d.alternative || 'none given'}`).join('\n')
}

export function bandOrder<T extends { level: Level }>(list: T[]): T[] {
  const newest = [...list].reverse()
  return [...newest.filter(d => d.level === 'undo'), ...newest.filter(d => d.level === 'know')]
}

const rethinkPrompt = (d: Decision) => `Rethink this decision you made: "${d.decision}" (because ${d.reason}). Undo it if you can, propose other ways, and ask me before picking one.`

export function correctionPrompt(wrong: Assumption[], right: Assumption[]): string {
  const lines = [
    `I checked the assumptions you listed. ${wrong.length === 1 ? 'This one is' : 'These are'} wrong:`,
    ...wrong.map(a => `- ${a.text}`),
    ...(right.length ? ['', 'These are right, keep them:', ...right.map(a => `- ${a.text}`)] : []),
    '',
    'Fix the work so it no longer rests on the wrong ones. Where you cannot tell what is right instead, ask me before you change anything.',
  ]
  return lines.join('\n')
}

const AUTO_PROMPT = `Based on what you already know of this project and its instructions, propose up to 6 areas where a decision you make on your own would be critical for me (rules, money, data, publishing, scope or anything this project treats as important). For each: a short snake_case name, keywords as they appear in the work, and path globs when it lives in specific files. Save them with the save_critical_areas tool (load it with ToolSearch if it is not listed), with a one-line description in my language. Then show me the areas and tell me /critical-areas clear undoes it. Do not read new files just for this.`

// ---------- State ----------

let config: Config | undefined
let cwd = ''
let nextId = 1
const decisions: Decision[] = []
let learned: Learned[] = []
const warned = new Set<string>()
let nudged = false

async function readSwitch($: EngineInterface) {
  try {
    const json = await readSwitches($)
    const was = JSON.stringify(parts)
    parts.on = isOn(json, PLUGIN) && json[`${PLUGIN}:hidden`] !== true
    parts.decisions = isPartOn(json, PLUGIN, 'decisions')
    parts.assumptions = isPartOn(json, PLUGIN, 'assumptions')
    parts.nudge = isPartOn(json, PLUGIN, 'nudge')
    if (was !== JSON.stringify(parts)) {
      try {
        $.ui.invalidate('ui.render')
      } catch {
        // Only drawing.
      }
    }
  } catch {
    // A broken file changes nothing.
  }
}

async function getPending($: EngineInterface): Promise<Decision[]> {
  return (await $.state.get(PENDING)).value ?? []
}
async function getAssumptions($: EngineInterface): Promise<Assumption[]> {
  return (await $.state.get(ASSUMPTIONS)).value ?? []
}

async function dismissNotice($: EngineInterface) {
  if ((await $.state.get(NOTICE)).value) {
    await $.state.set(NOTICE, false)
    await $.store.set(noticeKey(cwd), true)
  }
}

async function press($: EngineInterface, el: string) {
  const pending = await getPending($)
  const list = await getAssumptions($)
  if (el === 'ok') {
    await $.state.set(PENDING, [])
    await dismissNotice($)
    return
  }
  if (el === 'notice-ok') return dismissNotice($)
  let m = /^(rethink|not-critical)-(\d+)$/.exec(el)
  if (m) {
    const d = pending.find(x => x.id === Number(m![2]))
    if (!d) return
    await $.state.set(PENDING, pending.filter(x => x.id !== d.id))
    if (m[1] === 'rethink') {
      $.clock.after(1, () => void $.prompt.submit({ text: rethinkPrompt(d), asUser: true }))
    } else {
      learned = [...learned, { area: d.area, decision: d.decision.slice(0, 160) }].slice(-LEARNED_MAX)
      await $.store.set(learnedKey(cwd), learned)
    }
    return
  }
  m = /^(right|wrong)-(\d+)$/.exec(el)
  if (m) {
    const id = Number(m[2])
    const mark = m[1] as 'right' | 'wrong'
    await $.state.set(
      ASSUMPTIONS,
      list.map(a => (a.id === id ? { ...a, mark: (a.mark === mark ? 'open' : mark) as Assumption['mark'] } : a)),
    )
    return
  }
  if (el === 'send-fixes') {
    const wrong = list.filter(a => a.mark === 'wrong')
    if (!wrong.length) return
    const right = list.filter(a => a.mark === 'right')
    await $.state.set(ASSUMPTIONS, [])
    $.clock.after(1, () => void $.prompt.submit({ text: correctionPrompt(wrong, right), asUser: true }))
    return
  }
  if (el === 'all-right' || el === 'close-assumptions') await $.state.set(ASSUMPTIONS, [])
}

// ---------- Drawing ----------

function decisionsView(els: Record<string, any>, pending: Decision[], width: number) {
  const { Box, Text, Button } = els
  const noop = () => undefined
  const ordered = bandOrder(pending)
  const shown = ordered.slice(0, BAND_ROWS)
  const more = ordered.length - shown.length
  const toUndo = pending.filter(d => d.level === 'undo').length
  const toKnow = pending.length - toUndo
  const counts = [toUndo ? `${toUndo} ${LEVEL_LABEL.undo}` : '', toKnow ? `${toKnow} ${LEVEL_LABEL.know}` : ''].filter(Boolean).join(' · ')
  return (
    <Box key="decisions" flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Text>
          <Text bold color={GRADIENT[2]}>{`${MARK[PLUGIN]} `}</Text>
          <Text bold color={toUndo ? STATUS.bad : STATUS.warn}>{`Decisions Claude made · ${counts}`}</Text>
        </Text>
        <Button key="ok" label="OK" role="dismiss" onPress={noop} />
      </Box>
      {shown.map(d => (
        <Box key={`row-${d.id}`} flexDirection="row" justifyContent="space-between" width={width} gap={1}>
          <Box flexShrink={1} flexGrow={1}>
            <Text wrap="wrap">
              <Text color={d.level === 'undo' ? STATUS.bad : STATUS.warn}>{d.level === 'undo' ? '● ' : '○ '}</Text>
              <Text>{d.decision}</Text>
              <Text dimColor>{` · ${d.reason}`}</Text>
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Button key={`rethink-${d.id}`} label="Rethink" onPress={noop} />
            <Button key={`not-critical-${d.id}`} label="Not critical" onPress={noop} />
          </Box>
        </Box>
      ))}
      {more ? <Text dimColor>{`+${more} more: /critical-list`}</Text> : null}
    </Box>
  )
}

function assumptionsView(els: Record<string, any>, list: Assumption[], width: number) {
  const { Box, Text, Button } = els
  const noop = () => undefined
  const wrong = list.filter(a => a.mark === 'wrong').length
  const open = list.filter(a => a.mark === 'open').length
  return (
    <Box key="assumptions" flexDirection="column" borderStyle="round" borderColor={GRADIENT[2]} paddingX={1} width={width}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold color={GRADIENT[1]}>{`${MARK[PLUGIN]} `}</Text>
          <Text bold>{`Claude assumed ${list.length} thing${list.length === 1 ? '' : 's'}`}</Text>
          <Text dimColor>{open ? ' · mark each right or wrong (Tab moves)' : ''}</Text>
        </Text>
        <Button key="close-assumptions" label="Close" role="dismiss" onPress={noop} />
      </Box>
      {list.map(a => (
        <Box key={`a-${a.id}`} flexDirection="row" justifyContent="space-between" gap={1}>
          <Box flexShrink={1} flexGrow={1}>
            <Text wrap="wrap" dimColor={a.mark === 'right'} strikethrough={a.mark === 'wrong'}>
              <Text color={a.mark === 'wrong' ? STATUS.bad : a.mark === 'right' ? STATUS.good : ACCENT}>{a.mark === 'wrong' ? '✗ ' : a.mark === 'right' ? '✓ ' : '• '}</Text>
              {oneLine(a.text)}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1} flexShrink={0}>
            <Button key={`right-${a.id}`} label="Right" variant={a.mark === 'right' ? 'primary' : undefined} onPress={noop} />
            <Button key={`wrong-${a.id}`} label="Wrong" variant={a.mark === 'wrong' ? 'primary' : undefined} onPress={noop} />
          </Box>
        </Box>
      ))}
      <Box flexDirection="row" gap={1}>
        {wrong ? <Button key="send-fixes" label={`Send ${wrong} back to Claude`} variant="primary" onPress={noop} /> : <Button key="all-right" label="All right" onPress={noop} />}
      </Box>
    </Box>
  )
}

// ---------- Hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    cwd = e.cwd
    await readSwitch($)
    $.clock.every(3000, () => {
      void readSwitch($)
    })
    config = ((await $.store.get(storeKey(cwd))) as Config | undefined) ?? undefined
    learned = ((await $.store.get(learnedKey(cwd))) as Learned[] | undefined) ?? []
    await $.state.set(NOTICE, !config && !(await $.store.get(noticeKey(cwd))))
    await $.tool.register({
      name: 'record_decision',
      description:
        'Record a critical decision you made on your own, mid-task, that the user did not literally ask for (see "Critical decisions" in the system prompt). The user sees it right away above the prompt. Call it once per decision, then mention the decision in your reply.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'One of the areas the user marked as critical, or "general" when only the default criteria apply. Example: "pricing".' },
          decision: {
            type: 'string',
            description: 'One plain sentence for the user, in the language they write in, making clear it was your call and what it replaced. Example: "I picked a 40% margin myself, since you did not give one."',
          },
          reason: { type: 'string', description: 'Why, in a few words, in the same language. Example: "it is common in 3D printing and covers machine wear".' },
          alternative_ruled_out: { type: 'string', description: 'What the user asked for, or what you would otherwise have done.' },
          level: { type: 'string', enum: ['undo', 'know'], description: '"undo" when the user may well want it taken back; "know" when it is a reasonable choice they should be aware of. Default "know".' },
        },
        required: ['area', 'decision', 'reason'],
      },
    })
    await $.tool.register({
      name: 'list_assumptions',
      description:
        'At the end of a task, list the assumptions your result rests on that the user did not state (see "Assumption check" in the system prompt). The user marks each right or wrong; the wrong ones come back to you to fix. Call it once, right before your final reply.',
      isDeferred: false,
      inputSchema: {
        type: 'object',
        properties: {
          assumptions: {
            type: 'array',
            description: `1 to ${MAX_ASSUMPTIONS}, most consequential first.`,
            items: {
              type: 'object',
              properties: {
                assumption: { type: 'string', description: 'One plain sentence the user can mark right or wrong. Example: "The prices on the page are in US dollars."' },
                why: { type: 'string', description: 'What it is based on, in a few words. Optional.' },
              },
              required: ['assumption'],
            },
          },
        },
        required: ['assumptions'],
      },
    })
    await $.tool.register({
      name: 'save_critical_areas',
      description: 'Save the areas that are critical in this project, replacing the current ones. Use it only when the user asked for it (/critical-areas auto).',
      isDeferred: true,
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: "One line, in the user's language." },
          areas: {
            type: 'array',
            description: '1 to 6 areas.',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }, paths: { type: 'array', items: { type: 'string' } } },
              required: ['name', 'keywords', 'paths'],
            },
          },
        },
        required: ['description', 'areas'],
      },
    })
    await $.command.register({ name: 'critical-areas', description: 'Assumption Radar: say what is critical in this project ("auto": Claude proposes it; no text: show it; "clear": remove it)' })
    await $.command.register({ name: 'critical-list', description: 'Assumption Radar: list the critical decisions recorded in this chat' })
    await $.command.register({ name: 'assumptions', description: 'Assumption Radar: show the assumptions from the last task again', immediate: true })
    return r
  })

  on('command.run', { command: 'critical-areas' }, async ($, e) => {
    const args = e.args.trim()
    if (!args) return { text: describeConfig(config, learned) }
    if (CLEAR.has(args.toLowerCase())) {
      config = undefined
      learned = []
      await $.store.delete(storeKey(cwd))
      await $.store.delete(learnedKey(cwd))
      return { text: 'Removed, along with what was marked as not critical. Only the default protection is on in this project now.' }
    }
    if (args.toLowerCase() === 'auto') {
      $.clock.after(1, () => void $.prompt.submit({ text: AUTO_PROMPT, asUser: true }))
      return { text: 'Asking Claude to propose the critical areas of this project.' }
    }
    const r = await $.model.complete({ model: 'haiku', system: EXTRACT_SYSTEM, prompt: args, maxTokens: 1500, timeoutMs: 30000 })
    const areas = r.isAnswered ? parseAreas(r.text) : undefined
    if (!areas) return { text: `Nothing saved: ${r.isAnswered ? 'the answer could not be read as areas' : `the model call failed (${r.reason})`}. Try again, naming files, folders or terms.` }
    config = { description: args, areas }
    await $.store.set(storeKey(cwd), config)
    await dismissNotice($)
    return { text: `Saved for ${cwd}.\n\n${describeConfig(config, learned)}` }
  })

  on('command.run', { command: 'critical-list' }, () => ({ text: report(decisions) }))

  on('command.run', { command: 'assumptions' }, async $ => {
    const list = await getAssumptions($)
    if (!list.length) return { text: 'No assumptions to review. Claude lists them at the end of a task that produced or changed something.' }
    try {
      $.ui.invalidate('ui.render')
    } catch {
      // Only drawing.
    }
    return { text: `${list.length} assumption(s) above the prompt.` }
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!parts.on || (!parts.decisions && !parts.assumptions)) return r
    return { ...r, sections: [...r.sections, { id: `${PLUGIN}:rules`, text: systemSection(config, learned, parts.assumptions, parts.decisions), scope: 'session' as const }] }
  })

  // One hook for every tool call: the mod's own tools are answered here, the rest are watched.
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (tool === DECISION_TOOL) {
      const decision = String(input.decision ?? '').trim()
      const reason = String(input.reason ?? '').trim()
      if (!decision || !reason) return { result: 'Nothing recorded: "decision" and "reason" must each be one non-empty sentence. Call record_decision again with both.', isError: true } as never
      const d: Decision = {
        id: nextId++,
        time: new Date(await $.clock.now()).toTimeString().slice(0, 5),
        level: input.level === 'undo' ? 'undo' : 'know',
        area: String(input.area || 'general'),
        decision,
        reason,
        alternative: String(input.alternative_ruled_out ?? ''),
      }
      decisions.push(d)
      nudged = true
      if (parts.on && parts.decisions) {
        await $.state.set(PENDING, [...(await getPending($)), d])
        try {
          $.ui.toast(`${d.level === 'undo' ? '●' : '○'} Claude decided: ${d.decision}`, { timeoutMs: 12000 })
        } catch {
          // Only a hint.
        }
      }
      return { result: `Decision recorded (${decisions.length} this chat) and the user was told. Mention it in your reply.` } as never
    }
    if (tool === ASSUME_TOOL) {
      const raw = Array.isArray(input.assumptions) ? (input.assumptions as { assumption?: unknown; why?: unknown }[]) : []
      const list: Assumption[] = raw
        .map(a => ({ text: String(a?.assumption ?? '').trim(), why: String(a?.why ?? '').trim() }))
        .filter(a => a.text)
        .slice(0, MAX_ASSUMPTIONS)
        .map((a, i) => ({ id: i + 1, text: a.text, why: a.why, mark: 'open' as const }))
      if (!list.length) return { result: 'Nothing listed: give 1 to 6 assumptions, each one sentence.', isError: true } as never
      if (parts.on && parts.assumptions) await $.state.set(ASSUMPTIONS, list)
      return { result: `Listed ${list.length} assumption(s) for the user to check. Do not repeat them in your reply; say in one line that they are above the prompt to mark right or wrong.` } as never
    }
    if (tool === SAVE_TOOL) {
      const areas = areasFrom(input.areas)
      const description = String(input.description ?? '').trim()
      if (!areas || !description) return { result: 'Nothing saved: give a one-line "description" and 1 to 6 "areas", each with a name and at least one keyword or path.', isError: true } as never
      config = { description, areas: areas.slice(0, 6) }
      await $.store.set(storeKey(cwd), config)
      await dismissNotice($)
      return { result: `Saved. Show the user these areas and say /critical-areas clear undoes it.\n\n${describeConfig(config, learned)}` } as never
    }
    if (!parts.on || !parts.decisions) return next(e)
    const areas = touchedAreas(config, tool, input).filter(a => !warned.has(a))
    const r = await next(e)
    if (r.deny !== undefined || r.isError === true) return r
    const notes: string[] = []
    if (areas.length) {
      areas.forEach(a => warned.add(a))
      notes.push(reminder(areas))
    }
    const writes = EDIT_TOOLS.has(tool) || (tool.startsWith('mcp__') && !tool.startsWith(`mcp__${PLUGIN}__`))
    if (writes && !nudged && parts.nudge) {
      nudged = true
      notes.push(writeNudge())
    }
    if (!notes.length) return r
    return { ...r, context: [...(r.context ?? []), ...notes] } as typeof r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async (_$, e, next) => {
    if (e.agentId === undefined) {
      warned.clear()
      nudged = false
    }
    return next(e)
  })

  on('ui.press', { plugin: 'assumption-radar' }, async ($, e) => {
    await press($, e.element)
    return { element: e.element }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => roomy(await (async () => {
    if (!parts.on || e.props.hasSurvey) return next(e)
    const pending = parts.decisions ? await getPending($) : []
    const list = parts.assumptions && !e.props.isWorking ? await getAssumptions($) : []
    const notice = parts.decisions && (await $.state.get(NOTICE)).value === true
    if (!pending.length && !list.length && !notice) return next(e)
    const rest = await next(e)
    const els = $.ui.resolve(e) as Record<string, any>
    const { Box, Text, Button } = els
    const width = Math.max(30, e.props.bodyColumns)
    return (
      <Box flexDirection="column">
        {rest}
        {pending.length ? decisionsView(els, pending, width) : null}
        {!pending.length && notice ? (
          <Box flexDirection="row" justifyContent="space-between" width={width}>
            <Text wrap="truncate-end">
              <Text bold color={GRADIENT[2]}>{`${MARK[PLUGIN]} `}</Text>
              <Text dimColor>Assumption Radar is on. Tell it what matters most here: /critical-areas auto</Text>
            </Text>
            <Button key="notice-ok" label="OK" role="dismiss" onPress={() => undefined} />
          </Box>
        ) : null}
        {list.length ? assumptionsView(els, list, width) : null}
      </Box>
    )
  })(), e.surface))
}
