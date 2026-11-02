// Rule Keeper (Solomon Mods): what Claude should remember, and how.
// - Reflect: the moment you correct Claude, offer "Save this as a rule?". Approved rules go to your
//   Obsidian vault (Rules/ in the vault set in ~/.claude/mods/settings.json), or to this chat only (a pin),
//   or to every chat (~/.claude/CLAUDE.md).
// - Pins (after YeonwooSung's Pin Memo, Apache-2.0, rewritten here in English): notes and
//   clickable to-dos above the prompt, kept per folder and chat.
// New in the merge: a pinned rule reaches Claude itself, as a short section of this chat's
// system prompt, so "for this chat" rules work without touching any file.

import type { EngineInterface, Register, SessionMessage } from 'claude-code'

import type { Band, Pin, Pins } from '../types'
import { GRADIENT, MARK, STATUS, cut, homeOf, isOn, isPartOn, log as suiteLog, oneLine, readSwitches, writeSwitches, roomy, vaultPath } from './suite'

const NAME = 'rule-keeper'
const BAND = { plugin: 'rule-keeper', key: 'band' } as const
const PINS = { plugin: 'rule-keeper', key: 'pins' } as const

const DEFAULT_FOLDER = '~/Documents/rules'
const CANCEL = 'Cancel'
const HEADING = '## Rules from corrections'
const SAVED_MS = 8000
const MAX_PINS = 100
const SHOWN_PINS = 8

const HINTS = [
  /\bno\b/i,
  /\bdon'?t\b/i,
  /\bdo not\b/i,
  /\bnever\b/i,
  /\bstop\b/i,
  /\binstead\b/i,
  /\bi said\b/i,
  /\bwrong\b/i,
  /\btoo (long|short|much|many|wordy|formal|casual)\b/i,
  /\bshorter\b/i,
  /\bnot like that\b/i,
  /\balways\b/i,
  /\buse\b.{1,40}\bnot\b/i,
  /\bremove\b/i,
  /\bavoid\b/i,
]

let home = ''
let configured = ''
let gen = 0
let turnDone = true
let pending: { rule: string; slug: string; correction: string } | null = null
let nextId = 1
let pinKey = ''
const parts = { on: true, reflect: true, pins: true, context: true }

const log = ($: EngineInterface, line: string) => suiteLog($, NAME, line)
const tilde = (p: string) => (home && p.startsWith(home) ? `~${p.slice(home.length)}` : p)

async function readSwitch($: EngineInterface) {
  try {
    const json = await readSwitches($)
    const was = { ...parts }
    parts.on = isOn(json, NAME)
    parts.reflect = isPartOn(json, NAME, 'reflect')
    parts.pins = isPartOn(json, NAME, 'pins') && json[`${NAME}:hidden`] !== true
    parts.context = isPartOn(json, NAME, 'context')
    if (!parts.on || !parts.reflect) pending = null
    if (was.on !== parts.on || was.pins !== parts.pins || was.reflect !== parts.reflect) {
      try {
        $.ui.invalidate('ui.render')
      } catch {
        // The next state change redraws anyway.
      }
    }
  } catch {
    // A broken file changes nothing.
  }
}

async function getBand($: EngineInterface): Promise<Band | null> {
  return (await $.state.get(BAND)).value ?? null
}
async function setBand($: EngineInterface, b: Band | null) {
  await $.state.set(BAND, b)
}

async function today($: EngineInterface) {
  const d = new Date(await $.clock.now())
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ---------- Pins ----------

const emptyPins = (): Pins => ({ nextId: 1, items: [] })

function decodePins(v: unknown): Pins {
  if (!v || typeof v !== 'object') return emptyPins()
  const o = v as { nextId?: unknown; items?: unknown }
  if (!Array.isArray(o.items) || typeof o.nextId !== 'number') return emptyPins()
  const items: Pin[] = []
  for (const raw of o.items.slice(0, MAX_PINS)) {
    const p = raw as Partial<Pin>
    if (typeof p.id !== 'number' || typeof p.text !== 'string' || !p.text) continue
    items.push({ id: p.id, text: p.text, checked: typeof p.checked === 'boolean' ? p.checked : null, rule: p.rule === true })
  }
  return { nextId: Math.max(o.nextId, ...items.map(i => i.id + 1), 1), items }
}

async function loadPins($: EngineInterface) {
  const [cwd, sid] = await Promise.all([$.session.cwd(), $.session.id()])
  pinKey = `pins:${JSON.stringify([cwd.replace(/\/+$/, ''), sid])}`
  const doc = decodePins(await $.store.get(pinKey).catch(() => undefined))
  await $.state.set(PINS, doc)
  return doc
}

async function getPins($: EngineInterface): Promise<Pins> {
  return (await $.state.get(PINS)).value ?? (await loadPins($))
}

async function savePins($: EngineInterface, doc: Pins) {
  if (!pinKey) await loadPins($)
  await $.store.set(pinKey, doc)
  await $.state.set(PINS, doc)
}

const clean = (t: string) =>
  t
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
    .trim()

const HELP = [
  '/pin <note>              pin a note',
  '/pin - [ ] <to-do>       pin a to-do with a checkbox',
  '/pin rule <rule>         pin a rule Claude follows in this chat',
  '/pin list · /pin clear',
  '/pin check|uncheck|toggle|remove <number>',
  '/pin edit <number> <text>',
].join('\n')

function listText(doc: Pins) {
  if (!doc.items.length) return 'No pins yet. Type /pin followed by a note.'
  return doc.items.map(p => `${p.id} ${p.rule ? '❖ rule:' : p.checked === null ? '·' : p.checked ? '[x]' : '[ ]'} ${p.text}`).join('\n')
}

function parseItem(raw: string): { text: string; checked: boolean | null } {
  const c = clean(raw)
  const m = /^(?:-\s+)?\[([ xX])\](?:\s+|$)([\s\S]*)$/.exec(c)
  const text = (m ? m[2]! : c).trim()
  if (!text) throw new Error('Type something to pin. /pin help shows how.')
  if (text.length > 2000) throw new Error('A pin holds at most 2,000 characters.')
  return { text, checked: m ? m[1]!.toLowerCase() === 'x' : null }
}

/** Runs one /pin command against the list. Pure: returns the new list and what to say. */
export function pinCommand(doc: Pins, args: string): { doc: Pins; text: string } {
  const raw = args.trim()
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(raw)
  const cmd = (m?.[1] ?? 'list').toLowerCase()
  const rest = m?.[2] ?? ''
  if (cmd === 'help') return { doc, text: HELP }
  if (cmd === 'list' && !rest) return { doc, text: listText(doc) }
  if (cmd === 'clear' && !rest) return { doc: { ...doc, items: [] }, text: 'Pins cleared.' }
  if (['toggle', 'check', 'uncheck', 'remove', 'edit'].includes(cmd)) {
    const idm = /^(\d+)(?:\s+([\s\S]*))?$/.exec(rest)
    if (!idm) throw new Error(HELP)
    const id = Number(idm[1])
    const item = doc.items.find(p => p.id === id)
    if (!item) throw new Error(`There is no pin ${id}. /pin list shows them.`)
    if (cmd === 'remove') return { doc: { ...doc, items: doc.items.filter(p => p.id !== id) }, text: `Pin ${id} removed.` }
    if (cmd === 'edit') {
      if (!idm[2]) throw new Error(HELP)
      const next = parseItem(idm[2])
      return { doc: { ...doc, items: doc.items.map(p => (p.id === id ? { ...p, ...next } : p)) }, text: `Pin ${id} changed.` }
    }
    if (item.checked === null) throw new Error(`Pin ${id} is a note, not a to-do.`)
    const checked = cmd === 'toggle' ? !item.checked : cmd === 'check'
    return { doc: { ...doc, items: doc.items.map(p => (p.id === id ? { ...p, checked } : p)) }, text: `Pin ${id} ${checked ? 'done' : 'not done'}.` }
  }
  const isRule = cmd === 'rule'
  const item = parseItem(cmd === 'add' || isRule ? rest : raw)
  if (doc.items.length >= MAX_PINS) throw new Error(`You can pin at most ${MAX_PINS} things.`)
  const pin: Pin = { id: doc.nextId, text: item.text, checked: isRule ? null : item.checked, rule: isRule }
  return { doc: { nextId: doc.nextId + 1, items: [...doc.items, pin] }, text: isRule ? `Rule pinned (${pin.id}). Claude follows it for the rest of this chat.` : `Pinned (${pin.id}).` }
}

// ---------- Reflect ----------

function looksLikeCorrection(text: string) {
  const t = text.trim()
  if (!t || t.startsWith('/') || t.length > 1500) return false
  return HINTS.some(re => re.test(t))
}

function cleanRule(raw: string) {
  let r = raw
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-*"'`\s]+|["'`\s]+$/g, '')
  if (!r) return ''
  r = r[0]!.toUpperCase() + r.slice(1)
  if (!/[.!?]$/.test(r)) r += '.'
  return r
}

const STOP = new Set(['a', 'an', 'the', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'with', 'when', 'any', 'all', 'my', 'your'])

function cleanSlug(raw: string, rule: string) {
  const words = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .split('-')
      .filter(Boolean)
  let w = words(raw)
  if (w.length < 2) w = words(rule).filter(x => !STOP.has(x))
  return w.slice(0, 6).join('-').slice(0, 60) || 'rule'
}

function draftPrompt(correction: string, lastReply: string) {
  return `A person corrected an AI assistant. Turn the correction into ONE general rule the assistant should follow in every future chat.

The assistant's last reply (first 1,500 characters):
<reply>
${lastReply}
</reply>

The person's correction:
<correction>
${correction}
</correction>

Rules for the rule:
- One line, plain imperative English, under 20 words. Example: Never use em dashes in newsletter copy.
- General enough to apply next time, specific enough to act on. Name the kind of work it applies to when that matters.
- No em dashes.

Also give a 3 to 6 word kebab-case slug for it, for example no-em-dashes-in-newsletters.

Reply with JSON only: {"rule": "...", "slug": "..."}
If the message holds no lasting lesson (a one-off fix to this task only), reply {"rule": "NONE", "slug": ""}.`
}

export function parseDraft(text: string): { rule: string; slug: string } | null {
  const m = /\{[\s\S]*\}/.exec(text)
  let rule = ''
  let slug = ''
  if (m) {
    try {
      const j = JSON.parse(m[0]) as { rule?: unknown; slug?: unknown }
      rule = typeof j.rule === 'string' ? j.rule : ''
      slug = typeof j.slug === 'string' ? j.slug : ''
    } catch {
      // Fall through to the first line.
    }
  }
  if (!rule) rule = text.split('\n').find(l => l.trim()) ?? ''
  if (!rule || /^none\.?$/i.test(rule.trim())) return null
  const r = cleanRule(rule)
  if (!r || /^none\.?$/i.test(r)) return null
  return { rule: r, slug: cleanSlug(slug, r) }
}

function lastAssistantText(messages: readonly SessionMessage[]) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.text.trim()) return m.text
  }
  return ''
}

async function show($: EngineInterface, d: { rule: string; slug: string; correction: string }) {
  await setBand($, { phase: 'offer', id: nextId++, rule: d.rule, slug: d.slug, correction: d.correction, path: '', shortPath: '', note: '' })
}

async function check($: EngineInterface, text: string, mine: number) {
  if (!looksLikeCorrection(text)) return
  const lastReply = lastAssistantText(await $.session.messages())
  if (!lastReply) return
  const kind = await $.model.classify(text, ['correction', 'other'])
  if (kind !== 'correction' || mine !== gen) return
  const r = await $.model.complete({ model: 'sonnet', prompt: draftPrompt(text, lastReply.slice(0, 1500)), maxTokens: 300, timeoutMs: 30_000 })
  if (!r.isAnswered) throw new Error(`draft failed: ${r.reason}`)
  const draft = parseDraft(r.text)
  if (!draft || mine !== gen) return
  const d = { ...draft, correction: text.trim() }
  if (turnDone) await show($, d)
  else pending = d
}

export function withRule(old: string, line: string) {
  const lines = old.split('\n')
  const at = lines.findIndex(l => l.trim() === HEADING)
  if (at === -1) {
    const base = old.replace(/\s+$/, '')
    return `${base}${base ? '\n\n' : ''}${HEADING}\n\n${line}\n`
  }
  let end = lines.length
  for (let k = at + 1; k < lines.length; k += 1) {
    if (/^#{1,2}\s/.test(lines[k]!)) {
      end = k
      break
    }
  }
  let last = end
  while (last > at + 1 && !lines[last - 1]!.trim()) last -= 1
  const before = lines.slice(0, last)
  if (last === at + 1) before.push('')
  const after = lines.slice(end)
  const out = [...before, line, ...(after.length ? ['', ...after] : [])].join('\n')
  return out.endsWith('\n') ? out : `${out}\n`
}

async function saveEverywhere($: EngineInterface, b: Band) {
  const path = `${home}/.claude/CLAUDE.md`
  const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
  if (old.split('\n').some(l => l.startsWith(`- ${b.rule} (added `))) return { path, note: 'Already saved' }
  const next = withRule(old, `- ${b.rule} (added ${await today($)})`)
  const nextLines = new Set(next.split('\n'))
  if (next.length < old.length || old.split('\n').filter(l => l.trim()).some(l => !nextLines.has(l))) throw new Error('the new CLAUDE.md would lose lines; nothing written')
  await $.fs.write(path, next)
  if (String(await $.fs.read(path)) !== next) throw new Error('CLAUDE.md did not read back as written')
  return { path, note: '' }
}

function expand(p: string) {
  let r = p.trim()
  if (r === '~') r = home
  else if (r.startsWith('~/')) r = `${home}${r.slice(1)}`
  return r.replace(/\/+$/, '')
}

async function pickFolder($: EngineInterface) {
  if (configured.trim()) return expand(configured)
  // Your second brain first: the vault set in ~/.claude/mods/settings.json, in its Rules folder.
  const vault = await vaultPath($)
  if (vault) {
    await $.process.run(['mkdir', '-p', `${vault}/Rules`])
    return `${vault}/Rules`
  }
  const saved = await $.store.get('folder')
  if (typeof saved === 'string' && saved.trim()) return expand(saved)
  let answer = ''
  try {
    answer = (await $.ui.ask('Which folder should rule notes go in?', { options: [DEFAULT_FOLDER, CANCEL], header: 'Rules folder' })).trim()
  } catch {
    return ''
  }
  if (!answer || answer === CANCEL || (!answer.startsWith('/') && !answer.startsWith('~'))) return ''
  await $.store.set('folder', answer)
  return expand(answer)
}

function vaultNote(b: Band, date: string) {
  const title = b.rule.replace(/[.!?]+$/, '')
  const why = b.correction.replace(/\s+/g, ' ').trim().slice(0, 200).replace(/"/g, "'")
  return `---\ntitle: "${title.replace(/"/g, "'")}"\ntype: rule\nstatus: active\ncreated: ${date}\nupdated: ${date}\nsource: correction in a Claude Code chat\ntags: [rule]\n---\n\n# ${title}\n\n${b.rule}\n\nWhy: "${why}"\n`
}

async function saveToVault($: EngineInterface, b: Band) {
  const dir = await pickFolder($)
  if (!dir) return null
  let path = `${dir}/${b.slug}.md`
  for (let k = 2; (await $.fs.exists(path)) && k < 100; k += 1) path = `${dir}/${b.slug}-${k}.md`
  const text = vaultNote(b, await today($))
  await $.fs.write(path, text)
  if (String(await $.fs.read(path)) !== text) throw new Error('the rule file did not read back as written')
  return { path, short: tilde(path) }
}

async function hideLater($: EngineInterface, id: number) {
  await $.clock.sleep(SAVED_MS)
  const b = await getBand($)
  if (b && b.id === id && b.phase === 'saved') await setBand($, null)
}

async function markSaved($: EngineInterface, b: Band, path: string, shortPath: string, note: string) {
  const id = nextId++
  await setBand($, { ...b, phase: 'saved', id, path, shortPath, note })
  void hideLater($, id).catch(() => undefined)
}

async function fail($: EngineInterface, b: Band, what: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  await log($, `${what}: ${msg}`)
  await setBand($, { ...b, note: `Could not save: ${msg.slice(0, 120)}` })
}

async function press($: EngineInterface, element: string) {
  const b = await getBand($)
  if (element === 'skip') return setBand($, null)
  if (element === 'open') {
    if (b?.path) await $.process.run(['open', b.path])
    return
  }
  const pinHit = /^pin-(\d+)$/.exec(element)
  if (pinHit) {
    const doc = await getPins($)
    try {
      await savePins($, pinCommand(doc, `toggle ${pinHit[1]}`).doc)
    } catch {
      // A note has no checkbox.
    }
    return
  }
  if (!b || b.phase !== 'offer') return
  try {
    if (element === 'everywhere') {
      const r = await saveEverywhere($, b)
      await markSaved($, b, r.path, tilde(r.path), r.note)
    } else if (element === 'vault') {
      const r = await saveToVault($, b)
      if (!r) await setBand($, { ...b, note: 'No folder picked. Nothing saved.' })
      else await markSaved($, b, r.path, r.short, '')
    } else if (element === 'chat') {
      const r = pinCommand(await getPins($), `rule ${b.rule}`)
      await savePins($, r.doc)
      await markSaved($, b, '', 'this chat (pinned below)', 'Claude follows it from now on in')
    }
  } catch (err) {
    await fail($, b, `save ${element}`, err)
  }
}

// ---------- Drawing ----------

function offerView(els: Record<string, any>, b: Band) {
  const { Box, Text, Button } = els
  const noop = () => undefined
  if (b.phase === 'saved') {
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text wrap="truncate-middle">
          <Text color={STATUS.good}>✓ </Text>
          <Text>{b.note ? `${b.note} ` : 'Saved to '}</Text>
          <Text dimColor>{b.shortPath}</Text>
        </Text>
        {b.path ? <Button key="open" label="Open" onPress={noop} /> : null}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={GRADIENT[2]}>{`${MARK[NAME]} `}</Text>
        <Text bold>Save this as a rule?</Text>
      </Text>
      <Text>{`"${b.rule}"`}</Text>
      <Box flexDirection="row" gap={1}>
        <Button key="vault" label="Save to my vault" variant="primary" onPress={noop} />
        <Button key="chat" label="This chat only" onPress={noop} />
        <Button key="everywhere" label="Every chat (CLAUDE.md)" onPress={noop} />
        <Button key="skip" label="Skip" role="dismiss" onPress={noop} />
      </Box>
      {b.note ? <Text color={STATUS.bad}>{b.note}</Text> : null}
    </Box>
  )
}

function pinsView(els: Record<string, any>, doc: Pins, width: number) {
  const { Box, Text, Button } = els
  const noop = () => undefined
  const inner = Math.max(10, width - 4)
  const todos = doc.items.filter(p => p.checked !== null)
  const done = todos.filter(p => p.checked).length
  const rules = doc.items.filter(p => p.rule).length
  const shown = doc.items.slice(-SHOWN_PINS)
  const head = [`Pinned ${doc.items.length}`, todos.length ? `${done}/${todos.length} done` : '', rules ? `${rules} rule${rules === 1 ? '' : 's'} for Claude` : ''].filter(Boolean).join(' · ')
  return (
    <Box key="pins" flexDirection="column" width={width} borderStyle="round" borderColor={GRADIENT[2]} paddingX={1}>
      <Text>
        <Text bold color={GRADIENT[1]}>{`${MARK[NAME]} `}</Text>
        <Text bold>{head}</Text>
        {doc.items.length > shown.length ? <Text dimColor>{` · /pin list shows all`}</Text> : null}
      </Text>
      {shown.map(p =>
        p.checked !== null ? (
          <Box key={`row-${p.id}`} flexDirection="row">
            <Button key={`pin-${p.id}`} plain dimColor={p.checked} onPress={noop}>
              {p.checked ? '[x]' : '[ ]'}
            </Button>
            <Text dimColor={p.checked} strikethrough={p.checked} wrap="truncate-end">{` ${cut(oneLine(p.text), inner - 4)}`}</Text>
          </Box>
        ) : (
          <Box key={`row-${p.id}`} flexDirection="row">
            <Text color={p.rule ? GRADIENT[1] : undefined} wrap="truncate-end">
              {`${p.rule ? '❖ ' : '· '}${cut(oneLine(p.text), inner - 2)}`}
            </Text>
          </Box>
        ),
      )}
    </Box>
  )
}

// ---------- Hooks ----------

export const register: Register = (on, options) => {
  configured = typeof (options as { rules_folder?: unknown }).rules_folder === 'string' ? String((options as { rules_folder?: unknown }).rules_folder) : ''

  on('session.start', async ($, e, next) => {
    home = homeOf($)
    await $.command.register({ name: 'pin', description: 'Rule Keeper: pin a note, a to-do (- [ ] …) or a rule for this chat. /pin help', argumentHint: '<note> | rule <rule> | list | help' })
    await $.command.register({ name: 'reflect', description: 'Rule Keeper: correction → rule offers on or off. "/reflect folder" forgets the rules folder', argumentHint: '[on|off|folder]', immediate: true })
    await readSwitch($)
    $.clock.every(3000, () => {
      void readSwitch($)
    })
    await loadPins($).catch(err => log($, `pins: ${String(err)}`))
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const r = await next(e)
    if (e.reason === 'clear' || e.reason === 'resume') await loadPins($).catch(() => undefined)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    if (!parts.on || (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge')) return next(e)
    gen += 1
    turnDone = false
    pending = null
    const mine = gen
    const b = await getBand($)
    if (b?.phase === 'offer') await setBand($, null)
    if (parts.reflect) void check($, e.text, mine).catch(err => log($, `check: ${String(err)}`))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (parts.on && e.agentId === undefined) {
      turnDone = true
      if (pending) {
        const d = pending
        pending = null
        void show($, d).catch(() => undefined)
      }
    }
    return result
  })

  // Pinned rules reach Claude: a short section at the end of this chat's system prompt.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!parts.on || !parts.context) return r
    const doc = (await $.state.get(PINS)).value
    const rules = (doc?.items ?? []).filter(p => p.rule)
    if (!rules.length) return r
    const text = `# Rules the user pinned for this chat\nFollow these for the rest of this conversation:\n${rules.map(p => `- ${p.text}`).join('\n')}`
    return { ...r, sections: [...r.sections, { id: 'rule-keeper:pinned-rules', text, scope: 'session' as const }] }
  })

  on('command.run', { command: 'pin' }, async ($, e) => {
    if (!parts.on) return { text: 'Rule Keeper is off. Turn it on with /mods.' }
    try {
      const doc = await getPins($)
      const r = pinCommand(doc, e.args ?? '')
      if (r.doc !== doc) await savePins($, r.doc)
      return { text: r.text }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err) }
    }
  })

  on('command.run', { command: 'reflect' }, async ($, e) => {
    if (!parts.on) return { text: 'Rule Keeper is off. Turn it on with /mods.' }
    const arg = e.args.trim().toLowerCase()
    if (arg === 'folder') {
      await $.store.delete('folder')
      return { text: configured.trim() ? `Remembered folder cleared. Save to vault still uses the rules_folder setting: ${configured.trim()}` : 'Remembered folder cleared. Rule Keeper asks again at the next Save to vault.' }
    }
    const json = await readSwitches($, true)
    const now = arg === 'on' ? true : arg === 'off' ? false : !isPartOn(json, NAME, 'reflect')
    json[`${NAME}:reflect`] = now
    await writeSwitches($, json)
    await readSwitch($)
    if (!now) await setBand($, null)
    return { text: now ? 'Rule offers are on: a correction gets a "Save this as a rule?" offer.' : 'Rule offers are off. Type /reflect to turn them back on.' }
  })

  on('ui.press', { plugin: 'rule-keeper' }, async ($, e) => {
    await press($, e.element)
    return { element: e.element }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => roomy(await (async () => {
    if (!parts.on || e.props.hasSurvey) return next(e)
    const b = parts.reflect && !e.props.isWorking ? await getBand($) : null
    const doc = parts.pins ? (await $.state.get(PINS)).value : null
    if (!b && !doc?.items.length) return next(e)
    const rest = await next(e)
    const els = $.ui.resolve(e) as Record<string, any>
    const { Box } = els
    return (
      <Box flexDirection="column">
        {rest}
        {b ? offerView(els, b) : null}
        {doc?.items.length ? pinsView(els, doc, Math.max(20, e.props.bodyColumns)) : null}
      </Box>
    )
  })(), e.surface))
}
