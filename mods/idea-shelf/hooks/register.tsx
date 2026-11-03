// Idea Shelf (Solomon Mods): park side ideas without pulling Claude off the task.
// Start a message with "idea:" (or use /idea <text>) and it goes on the shelf instead of to Claude.
// The shelf is a note in your Obsidian vault, one per project: Idea Shelf/<project>.md, as a
// checklist you can also edit in Obsidian. The Idea Shelf tab shows each idea as a card:
// Send it to Claude when you are ready, or Drop it. A small count sits above the prompt.
// Set your vault in ~/.claude/mods/settings.json as {"vault": "/path/to/vault"}; without one the
// shelf is kept in ~/.claude/mods/ideas/.

import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Idea } from '../types'
import { ACCENT, STATUS, dayKey, homeOf, log, paletteAt, partOn, roomy, vaultPath } from './suite'

const NAME = 'idea-shelf'
const PANE = 'idea-shelf'
const IDEAS = { plugin: 'idea-shelf', key: 'ideas' } as const
const FILE = { plugin: 'idea-shelf', key: 'file' } as const
const NOTE = { plugin: 'idea-shelf', key: 'note' } as const
const OPEN_LINE = /^- \[ \] (?:(\d{4}-\d{2}-\d{2}) · )?(.*)$/

let project = 'General'

async function shelfFile($: EngineInterface) {
  const vault = await vaultPath($)
  return vault ? `${vault}/Idea Shelf/${project}.md` : `${homeOf($)}/.claude/mods/ideas/${project}.md`
}

async function readLines($: EngineInterface, file: string) {
  try {
    if (!(await $.fs.exists(file))) return []
    return String(await $.fs.read(file)).split('\n')
  } catch {
    return []
  }
}

async function load($: EngineInterface) {
  const file = await shelfFile($)
  const ideas: Idea[] = []
  ;(await readLines($, file)).forEach((l, i) => {
    const m = OPEN_LINE.exec(l)
    if (m) ideas.push({ line: i, date: m[1] ?? '', text: m[2]!.trim() })
  })
  await $.state.set(FILE, file)
  await $.state.set(IDEAS, ideas)
}

async function shelve($: EngineInterface, text: string) {
  const file = await shelfFile($)
  await $.process.run(['mkdir', '-p', file.slice(0, file.lastIndexOf('/'))])
  let lines = await readLines($, file)
  if (lines.length === 0) lines = [`# Idea Shelf · ${project}`, '', 'Ideas parked while working. Tick one in Obsidian, or use Send or Drop in Claude Code.', '']
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  lines.push(`- [ ] ${dayKey(Date.now())} · ${text.replace(/\s+/g, ' ').trim()}`, '')
  await $.fs.write(file, lines.join('\n'))
  await load($)
}

/** Marks an idea done (sent) or dropped in the note, so the vault keeps its history. */
async function close($: EngineInterface, idea: Idea, how: 'sent' | 'dropped') {
  const file = await shelfFile($)
  const lines = await readLines($, file)
  const at = lines[idea.line]?.includes(idea.text) ? idea.line : lines.findIndex(l => OPEN_LINE.test(l) && l.includes(idea.text))
  if (at < 0) return load($)
  lines[at] = how === 'sent' ? `- [x] ${lines[at]!.slice(6)} · sent ${dayKey(Date.now())}` : `- [x] ~~${lines[at]!.slice(6)}~~ · dropped ${dayKey(Date.now())}`
  await $.fs.write(file, lines.join('\n'))
  await load($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    project = (e.cwd.split('/').pop() || 'General').replace(/^scratch-.*$/, 'General')
    await $.command.register({ name: 'idea', description: 'Idea Shelf: park an idea for later, /idea <text>' })
    await $.command.register({ name: 'shelf', description: 'Idea Shelf: open the shelf' })
    await load($).catch(err => log($, NAME, `load: ${String(err)}`))
    return next(e)
  })

  on('command.run', { command: 'idea' }, async ($, e) => {
    const text = String(e.args ?? '').trim()
    if (!text) return { text: 'Write the idea after the command, like /idea a referral page.' }
    await shelve($, text)
    return { text: `On the shelf: ${text}` }
  })

  on('command.run', { command: 'shelf' }, async $ => {
    await load($)
    await $.ui.open({ id: PANE, title: 'Idea Shelf' })
    return { text: 'Idea Shelf is open.' }
  })

  // "idea: ..." goes to the shelf, not to Claude, so the current task is not interrupted.
  on('prompt.submit', async ($, e, next) => {
    const m = /^\s*(?:idea|shelf)\s*:\s*([\s\S]+)$/i.exec(e.text)
    if (!m || e.command || e.origin.kind !== 'composer' || !(await partOn($, NAME))) return next(e)
    await shelve($, m[1]!)
    $.ui.toast(`On the shelf for ${project}. Claude was not interrupted.`)
    return { drop: 'Shelved by Idea Shelf.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ideas = (await $.state.get(IDEAS)).value ?? []
    if (ideas.length === 0 || !(await partOn($, NAME, 'band'))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const rest = await next(e)
    return roomy(
      <Box flexDirection="column">{rest}<Box flexDirection="row" columnGap={1} alignItems="center">
        <Text color={STATUS.warn}>✦</Text>
        <Text dimColor>{ideas.length} idea{ideas.length === 1 ? '' : 's'} on the shelf for {project}</Text>
        <Button key="is-open" plain label="Open shelf" onPress={() => $.ui.open({ id: PANE, title: 'Idea Shelf' })} />
      </Box></Box>,
      e.surface,
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const cols = Math.max(30, e.props.bodyColumns)
    const ideas = (await $.state.get(IDEAS)).value ?? []
    const file = (await $.state.get(FILE)).value ?? ''
    const note = (await $.state.get(NOTE)).value ?? ''
    const inVault = !file.includes('/.claude/mods/ideas/')
    const parts: RenderChildren[] = [
      <Box key="head" flexDirection="row" columnGap={1} alignItems="center">
        <Text bold size="heading" color={ACCENT}>✦</Text>
        <Text bold size="heading">Idea Shelf</Text>
        <Text dimColor>{project} · {ideas.length} waiting</Text>
      </Box>,
    ]
    if ('Input' in ui) {
      const { Input } = ui
      parts.push(<Input key="is-add" placeholder="Park an idea without stopping Claude…" submitLabel="Shelve" onSubmit={async v => {
        if (!v.trim()) return
        await shelve($, v)
        await $.state.set(NOTE, 'Shelved.')
      }} />)
    } else {
      parts.push(<Text key="is-how" dimColor>Type "idea: …" in the prompt, or /idea …, to shelve one.</Text>)
    }
    if (note) parts.push(<Text key="is-note" color={STATUS.good}>{note}</Text>)
    if (ideas.length === 0) parts.push(<Text key="is-none" dimColor>The shelf is empty. Ideas you park show up here as cards.</Text>)
    ideas.forEach((idea, i) => {
      const color = paletteAt(i)
      parts.push(
        <Box key={`is-${idea.line}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={cols}>
          <Text wrap="wrap">
            <Text color={color} bold>● </Text>
            {idea.text}
          </Text>
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text dimColor size="caption">{idea.date || 'undated'}</Text>
            <Button key={`send-${idea.line}`} variant="primary" label="Send to Claude" onPress={async () => {
              await close($, idea, 'sent')
              await $.prompt.submit({ text: idea.text, asUser: true })
            }} />
            <Button key={`drop-${idea.line}`} plain dimColor label="Drop" onPress={() => close($, idea, 'dropped')} />
          </Box>
        </Box>,
      )
    })
    parts.push(
      <Text key="is-where" dimColor wrap="wrap">
        {inVault ? `Saved in your vault: Idea Shelf/${project}.md` : 'Saved in ~/.claude/mods/ideas. Add {"vault": "<your vault folder>"} to ~/.claude/mods/settings.json to keep the shelf in Obsidian.'}
      </Text>,
    )
    if (inVault && 'Link' in ui && file) {
      const { Link } = ui
      parts.push(<Link key="is-obs" href={`obsidian://open?path=${encodeURIComponent(file)}`} label="Open in Obsidian" />)
    }
    return roomy(<Box flexDirection="column" width={cols}>{parts}</Box>, e.surface)
  })
}


