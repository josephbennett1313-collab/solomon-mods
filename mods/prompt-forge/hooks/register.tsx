// Prompt Forge (Solomon Mods): one check on every prompt you send, so two mods never both stop it.
// - Long and loose (a voice-note brain dump): ask the questions that matter, then shape it into a brief in the
//   order Anthropic's prompting guide recommends: "Act as <role>", the job (numbered steps), the why,
//   the guardrails (as what to do), done means, and the output. Labelled after Ben AI's Brain Dump.
// - Short and vague: suggest a sharper version; you pick which is sent (Michael Goldenberg's Prompt Coach, MIT).
// - /forge <prompt>: upgrade any prompt on demand and put it in the box to edit (the Prompt Upgrade idea).
// Nothing is ever rewritten silently: every change needs your pick.

import type { EngineInterface, PromptSubmitInput, Register } from 'claude-code'

import { isOn, isPartOn, log as suiteLog, partOn, readSwitches, writeSwitches } from './suite'

const NAME = 'prompt-forge'
const settings = { coachModel: 'haiku', shapeModel: 'sonnet', minChars: 8, dumpWords: 120 }

// ---------- Brain dump → brief ----------
const HEADINGS = ['Act as', 'THE JOB', 'THE WHY', 'THE GUARDRAILS', 'DONE MEANS', 'OUTPUT'] as const
const MAX_QUESTIONS = 3
const SKIPPED = 'skipped, no answer'
const queue: string[] = []
const SHAPE = 'Shape it'
const AS_IS = 'Send as is'

const SHAPE_SYSTEM = `You rewrite a person's spoken brain dump into a clear brief for Claude, in the order Anthropic's prompting guide recommends: give Claude a role in one sentence, state the job plainly with numbered steps where order matters, give the context and the reason behind it, state the rules as what to do, say how success is judged, and be specific about the output.

Output exactly this shape and nothing else, no preamble, no code fences:

Act as <the expert best suited to this job, e.g. "a senior research producer for a YouTube channel">.

THE JOB
<what to make or do, in one plain line>
1. <step, when the order or the completeness of steps matters>
2. <step>

THE WHY
<who it is for, the background Claude needs, and why it matters>

THE GUARDRAILS
- <a rule, written as what to do: "Use only the files in X", not "Don't use other files">
- <a limit: time, length, budget, sources, what stays untouched>

DONE MEANS
- <how we know it is finished and right>

OUTPUT
<the format, length and where it goes>

Rules:
- Keep every fact, name, number, date, link, file and tool from the dump. Drop only filler and repeats.
- Add no new facts, numbers, names or requirements that are not in the dump. The role line may name a fitting expert.
- Where the dump says nothing for a part, write "unknown: ask me" for that part.
- The prompt may carry <answers>: follow-up questions the person answered. Treat each answer as their own words and use it in the part it belongs to. Where an answer says it was skipped, write that point as "unknown: ask me". Where an answer settles a clash, keep the winning side only.
- Write THE JOB to OUTPUT in the person's voice (I, we, my), as if they wrote the brief themselves.
- Plain, short English. Short lines, numbered steps and bullets. Tell Claude what to do, not what to avoid, wherever a rule can be put that way.
- Never use em dashes or en dashes.`

const GAPS_SYSTEM = `You read a person's spoken brain dump before it is turned into a brief for an AI assistant.
Find only real gaps: two instructions in the dump that clash, or a must-know fact that is missing and would change the work (who it is for, the deadline, the format, which source to use).

Return JSON only, no prose, no code fences, in exactly this shape:
{"questions":[{"kind":"clash","said":["<exact words from the dump>","<exact words from the dump>"],"q":"<short question ending in a question mark>","options":["<option>","<option>"]}]}

Rules:
- 0 to 3 questions. When the dump is clear, return {"questions":[]}. Fewer is better.
- kind is "clash" when two of the person's own instructions pull against each other; then "said" quotes both, word for word from the dump, each under 12 words. kind is "missing" otherwise, with "said" as [].
- Never ask about something the dump already answers, and never ask about style or nice-to-haves.
- For a clash, each option is one side, in 2 to 7 words. For a missing fact, 2 or 3 likely answers taken from the dump where possible. No "Other" option.
- Plain, short English. Never use em dashes or en dashes.`

// ---------- Coach ----------
const COACH_SYSTEM = `You review a person's prompt to Claude BEFORE it is sent. The person runs a business; the task may be writing, research, planning, data or code.
Decide if a rewrite would clearly get a better result. Most prompts are fine: only flag real problems:
vague goal, missing success criteria, ambiguous target ("fix it", "make it better"), several unrelated asks jammed together,
missing constraints Claude will need (which file, document or area, what not to touch, how to check the result).
Never change the person's intent, never add requirements they did not imply, keep their voice and language, keep it short.
Keep the KIND of message: a problem report stays a problem report, a request stays a request, a question stays a question.
Keep their scoping words ("for now", "just", "only", "first") and any constraints or preferences they stated.
If the prompt is a reply in an ongoing conversation (yes/no, "go ahead", answering a question), it is fine.
You get the recent conversation. Resolve "it", "this", "the other one" from it. If the conversation makes the prompt clear, it is fine.
When you do improve, make the SMALLEST edit: keep their own words and order, and only add what is missing.
Answer ONLY with JSON: {"verdict":"fine"} or {"verdict":"improve","why":"<max 12 words>","rewrite":"<the improved prompt>"}`

const FORGE_SYSTEM = `You upgrade a person's prompt to Claude into the strongest version of itself, keeping their intent, facts and voice, in the order Anthropic recommends.
Open with one line "Act as <the fitting expert>." Then add only what makes the result better: the goal in one line, who it is for and why, numbered steps where order matters, the rules as what to do, how to check it is done, and the format of the answer.
Never invent facts, numbers, names or sources. Where something important is unknown, write a short bracketed placeholder like [deadline?].
Plain, short English. No em dashes. Reply with the upgraded prompt only, no preamble, no code fences.`

const SKIP = /^\s*([/!#]|(y|yes|no|n|ok|okay|sure|go|go ahead|continue|proceed|thanks|thank you|do it|lgtm|nope|stop)\b[.!]?\s*$)/i

export type Gap = { q: string; options: string[]; said: string[] }
export type QA = { q: string; a: string | null }
type Verdict = { verdict: 'fine' } | { verdict: 'improve'; why: string; rewrite: string }

const log = ($: EngineInterface, line: string) => suiteLog($, NAME, line)
const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length
const fromPerson = (e: PromptSubmitInput) => e.origin.kind === 'composer' || e.origin.kind === 'sdk' || e.origin.kind === 'bridge'
const stripFences = (raw: string) =>
  raw
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/, '')
    .trim()
export const houseStyle = (raw: string) => raw.replace(/\s*[—–]\s*/g, ', ')
export const isBrainDump = (text: string) => {
  const t = text.trim()
  return !t.startsWith('/') && !/^Act as /m.test(t) && words(t) >= settings.dumpWords
}
export const tidy = (raw: string) => {
  const t = houseStyle(stripFences(raw))
  const start = t.search(/^Act as /m)
  return start > 0 ? t.slice(start) : t
}

function toast($: EngineInterface, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // Only a hint.
  }
}

function status($: EngineInterface, text: string | undefined) {
  try {
    $.ui.status(text)
  } catch {
    // Only a hint.
  }
}

const failWhy = (r: { reason: string; error?: string; status?: number | null }) =>
  r.reason === 'api-error' ? `the model call failed (${r.error}${r.status ? ` ${r.status}` : ''})` : r.reason === 'aborted' ? 'the model call timed out' : 'the model gave no text'

export const parseGaps = (raw: string): Gap[] => {
  const t = stripFences(raw)
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) throw new Error('no JSON object in the reply')
  const json = JSON.parse(t.slice(a, b + 1)) as { questions?: unknown }
  if (!Array.isArray(json.questions)) throw new Error('no questions list in the reply')
  const out: Gap[] = []
  for (const item of json.questions) {
    if (out.length >= MAX_QUESTIONS) break
    const { q, options, said } = (item ?? {}) as { q?: unknown; options?: unknown; said?: unknown }
    if (typeof q !== 'string' || !q.trim() || !Array.isArray(options)) continue
    const quotes = Array.isArray(said) ? said.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => houseStyle(x.trim())).slice(0, 2) : []
    const opts: string[] = []
    for (const o of options) {
      const label = typeof o === 'string' ? houseStyle(o.trim()) : ''
      if (!label || /^other$/i.test(label) || opts.includes(label)) continue
      if (opts.length < 3) opts.push(label)
    }
    if (opts.length < 2) continue
    let question = houseStyle(q.trim())
    if (!question.endsWith('?')) question = `${question}?`
    out.push({ q: question, options: opts, said: quotes.length === 2 ? quotes : [] })
  }
  return out
}

async function findGaps($: EngineInterface, dump: string): Promise<Gap[]> {
  try {
    const r = await $.model.complete({ model: settings.shapeModel, system: GAPS_SYSTEM, prompt: `Here is the brain dump. Return the JSON.\n\n<dump>\n${dump}\n</dump>`, maxTokens: 800, effort: 'low', timeoutMs: 45_000 })
    if (!r.isAnswered) {
      await log($, `gap check failed: ${failWhy(r)}`)
      return []
    }
    return parseGaps(r.text)
  } catch (err) {
    await log($, `gap check: ${String(err)}`)
    return []
  }
}

async function askGaps($: EngineInterface, gaps: Gap[]): Promise<QA[]> {
  const out: QA[] = []
  for (const [i, g] of gaps.entries()) {
    status($, `Prompt Forge: question ${i + 1} of ${gaps.length}`)
    let a: string | null = null
    try {
      const text = g.said.length === 2 ? `Two asks clash. Which one wins?\nYou said “${g.said[0]}” and also “${g.said[1]}”.` : g.q
      a = (await $.ui.ask(text, { options: g.options, header: `Dump ${i + 1} of ${gaps.length}` })).trim() || null
    } catch {
      a = null
    }
    out.push({ q: g.q, a })
  }
  return out
}

export const briefPrompt = (dump: string, qa: QA[]) => {
  let p = `Here is the brain dump. Rewrite it into the brief.\n\n<dump>\n${dump}\n</dump>`
  if (qa.length) {
    const lines = qa.map(x => `Q: ${x.q}\nA: ${x.a ?? SKIPPED}`).join('\n\n')
    p += `\n\nI asked the person these follow-up questions first. Use their answers in the brief.\n\n<answers>\n${lines}\n</answers>`
  }
  return p
}

async function shapeBrief($: EngineInterface, dump: string, qa: QA[]): Promise<string> {
  const r = await $.model.complete({ model: settings.shapeModel, system: SHAPE_SYSTEM, prompt: briefPrompt(dump, qa), maxTokens: 2000, effort: 'low', timeoutMs: 60_000 })
  if (!r.isAnswered) throw new Error(failWhy(r))
  const brief = tidy(r.text)
  if (!HEADINGS.every(h => brief.includes(h))) throw new Error('the brief came back without all its parts')
  return brief
}

async function fillBox($: EngineInterface, text: string): Promise<boolean> {
  const filled = await $.prompt.fill({ text, mode: 'replace' }).catch(() => null)
  return Boolean(filled?.isFilled)
}

/** The long-prompt path. Returns the hook's answer, or null to send as typed. */
async function shapeFlow($: EngineInterface, text: string) {
  let pick = ''
  try {
    pick = await $.ui.ask(`This looks like a brain dump (${words(text)} words). Shape it into a clear brief first?`, { options: [SHAPE, AS_IS], header: 'Prompt Forge' })
  } catch {
    return null
  }
  if (pick !== SHAPE) return null
  let qa: QA[] = []
  try {
    status($, 'Prompt Forge: reading for gaps')
    qa = await askGaps($, await findGaps($, text))
    status($, 'Prompt Forge: writing the brief')
    const brief = await shapeBrief($, text, qa)
    status($, undefined)
    if (!(await fillBox($, brief))) throw new Error('the prompt box did not take it')
    await log($, `shaped a brief: ${qa.length} questions`)
    toast($, 'Shaped into a brief. Check it, then press Enter.')
    return { drop: 'shaped into a brief' }
  } catch (err) {
    status($, undefined)
    const why = err instanceof Error ? err.message : String(err)
    toast($, `Could not shape it: ${why}. Sent as is.`)
    await log($, `shape failed: ${why}`)
    return null
  }
}

function recentTurns(messages: { role: string; text: string }[], max = 6, perMessage = 700): string {
  return messages
    .filter(m => m.text.trim() !== '')
    .slice(-max)
    .map(m => `${m.role === 'user' ? 'User' : 'Claude'}: ${m.text.length > perMessage ? `…${m.text.slice(-perMessage)}` : m.text}`)
    .join('\n\n')
}

/** Share of the prompt's meaningful words the rewrite kept; a low share means it was replaced, not improved. */
export function keptShare(prompt: string, rewrite: string): number {
  const pick = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}_./-]{4,}/gu) ?? []
  const original = new Set(pick(prompt))
  if (original.size < 3) return 1
  const kept = new Set(pick(rewrite))
  let hits = 0
  for (const w of original) if (kept.has(w)) hits += 1
  return hits / original.size
}

export function parseVerdict(text: string): Verdict | undefined {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (json === undefined) return undefined
  try {
    const v = JSON.parse(json) as Partial<{ verdict: string; why: string; rewrite: string }>
    if (v.verdict === 'improve' && typeof v.rewrite === 'string' && v.rewrite.trim() !== '') return { verdict: 'improve', why: v.why ?? '', rewrite: houseStyle(v.rewrite.trim()) }
    return { verdict: 'fine' }
  } catch {
    return undefined
  }
}

async function review($: EngineInterface, prompt: string): Promise<Verdict | undefined> {
  const messages = await $.session.messages().catch(() => [])
  const conversation = Array.isArray(messages) ? recentTurns(messages) : ''
  const r = await $.model.complete({
    model: settings.coachModel,
    system: COACH_SYSTEM,
    maxTokens: 700,
    timeoutMs: 15_000,
    prompt: `Recent conversation, oldest first (may be empty):\n"""${conversation}"""\n\nThe person's new prompt:\n"""${prompt}"""`,
  })
  const verdict = r.isAnswered ? parseVerdict(r.text) : undefined
  if (verdict?.verdict === 'improve' && keptShare(prompt, verdict.rewrite) < 0.5) return { verdict: 'fine' }
  return verdict
}

/** The short-prompt path. Returns the hook's answer, or null to send as typed. */
async function coachFlow($: EngineInterface, e: PromptSubmitInput, next: (e: PromptSubmitInput) => Promise<unknown>) {
  status($, 'Prompt Forge: checking your prompt')
  let verdict: Verdict | undefined
  try {
    verdict = await review($, e.text)
  } catch (err) {
    await log($, `coach: ${String(err)}`)
  } finally {
    status($, undefined)
  }
  if (!verdict || verdict.verdict === 'fine') return null
  const NEW = 'Send improved'
  const MINE = 'Send mine'
  const EDIT = 'Edit improved'
  let choice: string
  try {
    choice = await $.ui.ask(`${verdict.why}\n\n${verdict.rewrite}\n\nWhich should I send?`, { header: 'Prompt Forge', options: [NEW, MINE, EDIT] })
  } catch {
    return null
  }
  if (choice === MINE) return null
  if (choice === EDIT) {
    const rewrite = verdict.rewrite
    $.clock.after(150, () => void $.prompt.fill({ text: rewrite }))
    return { drop: 'Suggestion loaded into the prompt box. Edit it and press Enter.' }
  }
  const text = choice === NEW ? verdict.rewrite : choice
  try {
    $.ui.log(`Prompt Forge sent ${choice === NEW ? 'the improved' : 'your edited'} version:\n${text}`)
  } catch {
    // Only a note.
  }
  return next({ ...e, text })
}

async function forge($: EngineInterface, text: string) {
  const r = await $.model.complete({ model: settings.shapeModel, system: FORGE_SYSTEM, prompt: `Upgrade this prompt:\n"""${text}"""`, maxTokens: 1500, effort: 'low', timeoutMs: 45_000 })
  if (!r.isAnswered) throw new Error(failWhy(r))
  return houseStyle(stripFences(r.text))
}

export const register: Register = (on, options) => {
  const o = options as Record<string, unknown>
  if (typeof o.coachModel === 'string' && o.coachModel) settings.coachModel = o.coachModel
  if (typeof o.shapeModel === 'string' && o.shapeModel) settings.shapeModel = o.shapeModel
  if (Number(o.minChars) > 0) settings.minChars = Number(o.minChars)
  if (Number(o.dumpWords) > 0) settings.dumpWords = Number(o.dumpWords)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'forge', description: 'Prompt Forge: upgrade a prompt into its strongest version and put it in the box to edit', argumentHint: '<your prompt>' })
    await $.command.register({ name: 'after', description: 'Prompt Forge: queue a prompt to send when Claude finishes this turn, /after <prompt> (/after alone lists the queue)' })
    await $.command.register({ name: 'coach', description: 'Prompt Forge: suggestions for vague prompts on or off', argumentHint: '[on|off]', immediate: true })
    await $.command.register({ name: 'shape', description: 'Prompt Forge: the brain dump → brief offer on or off', argumentHint: '[on|off]', immediate: true })
    return r
  })

  for (const part of ['coach', 'shape'] as const) {
    on('command.run', { command: part }, async ($, e) => {
      const json = await readSwitches($, true)
      if (!isOn(json, NAME)) return { text: 'Prompt Forge is off. Turn it on with /mods.' }
      const arg = e.args.trim().toLowerCase()
      const now = arg === 'on' ? true : arg === 'off' ? false : !isPartOn(json, NAME, part)
      json[`${NAME}:${part}`] = now
      await writeSwitches($, json)
      return { text: `${part === 'coach' ? 'Prompt suggestions' : 'Brain dump shaping'} ${now ? 'on' : 'off'} in every chat.` }
    })
  }

  on('command.run', { command: 'after' }, async ($, e) => {
    if (!(await partOn($, NAME, 'after'))) return { text: 'The /after queue is switched off in /mods.' }
    const text = e.args.trim()
    if (text === 'clear') return ((queue.length = 0), { text: 'The /after queue is empty.' })
    if (!text) return { text: queue.length ? ['Queued, in order:', ...queue.map((q, i) => `${i + 1}. ${q.slice(0, 100)}`), '/after clear empties it.'].join('\n') : 'Nothing queued. /after <prompt> sends it when Claude finishes.' }
    queue.push(text)
    return { text: `Queued (${queue.length}). It is sent when Claude finishes this turn.` }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && !e.isAborted && queue.length && (await partOn($, NAME, 'after'))) {
      const text = queue.shift()!
      $.clock.after(800, () => void $.prompt.submit({ text, asUser: true }))
    }
    return r
  })

  on('command.run', { command: 'forge' }, async ($, e) => {
    const json = await readSwitches($)
    if (!isOn(json, NAME)) return { text: 'Prompt Forge is off. Turn it on with /mods.' }
    const text = e.args.trim()
    if (!text) return { text: 'Type /forge followed by your prompt, for example: /forge write a follow-up email to the bank' }
    try {
      status($, 'Prompt Forge: upgrading your prompt')
      const better = await forge($, text)
      status($, undefined)
      if (await fillBox($, better)) return { text: 'Upgraded prompt is in the box. Edit it, then press Enter.' }
      return { text: better }
    } catch (err) {
      status($, undefined)
      return { text: `Could not upgrade it: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  on('prompt.submit', async ($, e, next) => {
    const json = await readSwitches($)
    if (!isOn(json, NAME) || !fromPerson(e) || SKIP.test(e.text)) return next(e)
    if (isPartOn(json, NAME, 'shape') && isBrainDump(e.text)) {
      const done = await shapeFlow($, e.text)
      return done ?? next(e)
    }
    const t = e.text.trim()
    if (isPartOn(json, NAME, 'coach') && t.length >= settings.minChars && t.length <= 4000 && words(t) < settings.dumpWords) {
      const done = await coachFlow($, e, next as never)
      return (done as never) ?? next(e)
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
