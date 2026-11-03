// Collision Guard (Solomon Mods): stops two open chats editing the same file without you knowing.
// Every chat writes the files it edits to one shared list (~/.claude/mods/collisions.json).
// Before Claude edits a file another chat changed in the last 30 minutes, you choose:
// Proceed, Move to a worktree (a separate copy of the project), or Cancel.
// A red band above the prompt shows any file you share with another chat right now.

import type { EngineInterface, Register } from 'claude-code'

import type { Clash } from '../types'
import { STATUS, cut, log, partOn, readJson, roomy, writeJson } from './suite'

const NAME = 'collision-guard'
const CLASHES = { plugin: 'collision-guard', key: 'clashes' } as const
const NOTE = { plugin: 'collision-guard', key: 'note' } as const
const FILE = 'collisions.json'
const WINDOW = 30 * 60_000
const KEEP = 6 * 60 * 60_000

type Entry = { sid: string; at: number; where: string }
type Ledger = Record<string, Entry[]>

let sid = ''
let where = ''
const mine = new Set<string>()
const warned = new Set<string>()
const allowed = new Set<string>()

const pathOf = (e: Record<string, unknown>) => String(e.file_path ?? e.notebook_path ?? '')
const short = (p: string) => p.split('/').slice(-2).join('/')

async function ledger($: EngineInterface): Promise<Ledger> {
  return readJson<Ledger>($, FILE, {})
}

/** Other chats that touched `path` in the last 30 minutes, newest first. */
function others(l: Ledger, path: string, now: number) {
  return (l[path] ?? []).filter(x => x.sid !== sid && now - x.at < WINDOW).sort((a, b) => b.at - a.at)
}

async function record($: EngineInterface, path: string) {
  const now = Date.now()
  const l = await ledger($)
  for (const k of Object.keys(l)) {
    l[k] = (l[k] ?? []).filter(x => now - x.at < KEEP)
    if (l[k]!.length === 0) delete l[k]
  }
  l[path] = [...(l[path] ?? []).filter(x => x.sid !== sid), { sid, at: now, where }]
  await writeJson($, FILE, l)
}

/** Looks for files this chat edited that another chat has since changed. */
async function scan($: EngineInterface) {
  if (mine.size === 0) return
  const now = Date.now()
  const l = await ledger($)
  const clashes: Clash[] = []
  for (const path of mine) {
    const o = others(l, path, now)[0]
    if (!o) continue
    clashes.push({ path, other: o.where, mins: Math.round((now - o.at) / 60_000), at: o.at })
    if (!warned.has(`${path}@${o.at}`) && (await partOn($, NAME, 'toast'))) {
      warned.add(`${path}@${o.at}`)
      $.ui.toast(`Another chat (${o.where}) just edited ${short(path)}, a file this chat changed.`)
    }
  }
  await $.state.set(CLASHES, clashes)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sid = await $.session.id().catch(() => `s${Date.now()}`)
    const cwd = e.cwd || ''
    where = `${cwd.split('/').pop() || 'chat'} · ${sid.slice(0, 4)}`
    await $.command.register({ name: 'collisions', description: 'Collision Guard: files this chat shares with other open chats' })
    $.clock.every(10_000, () => void scan($).catch(err => log($, NAME, `scan: ${String(err)}`)))
    return next(e)
  })

  on('command.run', { command: 'collisions' }, async $ => {
    await scan($)
    const list = (await $.state.get(CLASHES)).value ?? []
    if (list.length === 0) return { text: `No clashes. This chat has edited ${mine.size} file${mine.size === 1 ? '' : 's'}, and no other chat touched them in the last 30 minutes.` }
    return { text: ['Files shared with another chat:', ...list.map(c => `- ${c.path}: ${c.other}, ${c.mins} min ago`)].join('\n') }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) || !(await partOn($, NAME))) return next(e)
    const path = pathOf(e as unknown as Record<string, unknown>)
    if (!path) return next(e)
    const o = others(await ledger($), path, Date.now())[0]
    if (o && !allowed.has(path) && (await partOn($, NAME, 'ask'))) {
      const mins = Math.max(1, Math.round((Date.now() - o.at) / 60_000))
      const pick = await $.ui.ask(`Another chat (${o.where}) edited ${short(path)} ${mins} min ago. If both chats keep editing it, one can overwrite the other. What now?`, ['Proceed', 'Move to a worktree', 'Cancel'])
      if (pick === 'Move to a worktree') {
        return { deny: `Collision Guard: another open chat is editing ${path}. Joseph chose to move this work to a git worktree. Create one (EnterWorktree, or git worktree add), then make this edit there.` }
      }
      if (pick !== 'Proceed') return { deny: `Collision Guard: Joseph cancelled this edit because another chat is working on ${path}. Ask him how to continue.` }
      allowed.add(path)
    }
    const r = await next(e)
    if (r.deny === undefined && r.isError !== true) {
      mine.add(path)
      await record($, path).catch(err => log($, NAME, `record: ${String(err)}`))
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = (await $.state.get(CLASHES)).value ?? []
    if (list.length === 0 || !(await partOn($, NAME))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns ?? 100
    return roomy(
      <Box flexDirection="column" borderStyle="round" borderColor={STATUS.bad} paddingX={1}>
        <Box flexDirection="row" columnGap={1}>
          <Text bold color={STATUS.bad}>⚠ Collision Guard</Text>
          <Text dimColor>{list.length} file{list.length === 1 ? '' : 's'} shared with another open chat</Text>
          <Button key="cg-clear" plain label="×" onPress={() => $.state.set(CLASHES, [])} />
        </Box>
        {list.slice(0, 4).map(c => (
          <Text key={`cg-${c.path}`} wrap="truncate-end">
            <Text color={STATUS.bad}>●</Text> {cut(short(c.path), 40)} <Text dimColor>· {c.other} · {c.mins} min ago</Text>
          </Text>
        ))}
        {list.length > 4 ? <Text dimColor>and {list.length - 4} more. Type /collisions for all.</Text> : null}
        <Text dimColor wrap="truncate-end">{cut('Tip: finish in one chat first, or ask Claude to move this work to a worktree.', width - 4)}</Text>
      </Box>,
      e.surface,
    )
  })
}
