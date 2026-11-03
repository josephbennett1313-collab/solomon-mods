// File Tree (Solomon Mods): a Files tab that shows what Claude is doing with your files.
// - Now: the file Claude is reading or editing this second, with a live dot.
// - Touched: every file this chat read or changed, with counts, newest first.
// - Tree: the project's folders, with changed files coloured like git sees them.
// Opens by itself the first time Claude edits a file (switch that off in /mods). /files opens it.

import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Node, Touch } from '../types'
import { ACCENT, LIVE, STATUS, cut, log, partOn, plural, roomy } from './suite'

const NAME = 'file-tree'
const PANE = 'file-tree'
const TOUCHED = { plugin: 'file-tree', key: 'touched' } as const
const TREE = { plugin: 'file-tree', key: 'tree' } as const
const NOW = { plugin: 'file-tree', key: 'now' } as const
const ROOT = { plugin: 'file-tree', key: 'root' } as const
const OPEN = { plugin: 'file-tree', key: 'open' } as const
const SKIP = new Set(['.git', 'node_modules', '.next', 'dist', 'build', '.venv', '__pycache__', '.DS_Store', '.cache', 'coverage'])
const MAX_NODES = 400
const READS = new Set(['Read', 'Glob', 'Grep', 'NotebookRead'])
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

let opened = false

const rel = (root: string, p: string) => (root && p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p)

async function gitChanges($: EngineInterface, root: string) {
  const out = new Map<string, string>()
  try {
    const r = await $.process.run(['git', '-C', root, 'status', '--porcelain'])
    for (const line of String(r.stdout ?? '').split('\n')) {
      if (line.length < 4) continue
      const code = line.slice(0, 2).trim() || 'M'
      const file = line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '')
      out.set(`${root}/${file}`, code)
    }
  } catch {
    // Not a git folder: no colours.
  }
  return out
}

/** The folder tree, folders open to depth 2 plus any folder the person opened. */
async function buildTree($: EngineInterface) {
  const root = (await $.state.get(ROOT)).value ?? ''
  if (!root) return
  const open = new Set((await $.state.get(OPEN)).value ?? [])
  const changed = await gitChanges($, root)
  const nodes: Node[] = []
  const walk = async (dir: string, depth: number) => {
    if (nodes.length >= MAX_NODES) return
    let entries: { name: string; kind: string }[] = []
    try {
      entries = (await $.fs.list(dir)).filter(x => !SKIP.has(x.name) && !x.name.startsWith('.'))
    } catch {
      return
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1))
    for (const x of entries) {
      if (nodes.length >= MAX_NODES) return
      const path = `${dir}/${x.name}`
      const dir2 = x.kind === 'dir'
      const sub = dir2 ? [...changed.keys()].some(k => k.startsWith(`${path}/`)) : false
      nodes.push({ path, name: x.name, depth, dir: dir2, changed: dir2 ? (sub ? '•' : '') : (changed.get(path) ?? '') })
      if (dir2 && (depth < 1 || open.has(path) || sub)) await walk(path, depth + 1)
    }
  }
  await walk(root, 0)
  await $.state.set(TREE, nodes)
}

async function touch($: EngineInterface, path: string, kind: 'read' | 'edit') {
  if (!path || path.includes('*')) return
  const cur = (await $.state.get(TOUCHED)).value ?? []
  const old = cur.find(t => t.path === path)
  const t: Touch = { path, reads: (old?.reads ?? 0) + (kind === 'read' ? 1 : 0), edits: (old?.edits ?? 0) + (kind === 'edit' ? 1 : 0), last: Date.now() }
  await $.state.set(TOUCHED, [t, ...cur.filter(x => x.path !== path)].slice(0, 200))
}

const codeColor = (c: string) => (c === '??' || c === 'A' ? STATUS.good : c === 'D' ? STATUS.bad : c ? STATUS.warn : undefined)
const codeWord = (c: string) => (c === '??' ? 'new' : c === 'A' ? 'added' : c === 'D' ? 'deleted' : c === '•' ? '' : c ? 'changed' : '')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.state.set(ROOT, e.cwd)
    await $.command.register({ name: 'files', description: 'File Tree: open the Files tab' })
    void buildTree($)
    $.clock.every(8000, () => void buildTree($).catch(err => log($, NAME, `tree: ${String(err)}`)))
    return next(e)
  })

  on('command.run', { command: 'files' }, async $ => {
    await buildTree($)
    await $.ui.open({ id: PANE, title: 'Files' })
    return { text: 'The Files tab is open.' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if ((!READS.has(tool) && !EDITS.has(tool)) || !(await partOn($, NAME))) return next(e)
    const x = e as unknown as Record<string, unknown>
    const path = String(x.file_path ?? x.notebook_path ?? x.path ?? '')
    const verb = EDITS.has(tool) ? 'Editing' : tool === 'Read' ? 'Reading' : 'Searching'
    await $.state.set(NOW, { verb, path: path || String(x.pattern ?? ''), at: Date.now() })
    const r = await next(e)
    await $.state.set(NOW, null)
    if (r.deny === undefined && path) await touch($, path, EDITS.has(tool) ? 'edit' : 'read')
    if (EDITS.has(tool) && !opened && (await partOn($, NAME, 'autoopen'))) {
      opened = true
      await $.ui.open({ id: PANE, title: 'Files' })
    }
    if (EDITS.has(tool)) void buildTree($)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cols = Math.max(30, e.props.bodyColumns)
    const root = (await $.state.get(ROOT)).value ?? ''
    const now = (await $.state.get(NOW)).value
    const touched = (await $.state.get(TOUCHED)).value ?? []
    const tree = (await $.state.get(TREE)).value ?? []
    const open = (await $.state.get(OPEN)).value ?? []
    const showTree = await partOn($, NAME, 'tree')
    const edits = touched.filter(t => t.edits > 0).length
    const parts: RenderChildren[] = [
      <Box key="head" flexDirection="row" columnGap={1} alignItems="center">
        <Text bold size="heading" color={ACCENT}>▤</Text>
        <Text bold size="heading">Files</Text>
        <Text dimColor>{cut(root.split('/').slice(-2).join('/'), cols - 12)}</Text>
      </Box>,
      <Box key="now" flexDirection="row" columnGap={1} borderStyle="round" borderColor={now ? LIVE : undefined} paddingX={1} width={cols}>
        <Text color={now ? LIVE : undefined} dimColor={!now}>{now ? '●' : '○'}</Text>
        <Text bold={!!now} dimColor={!now} wrap="truncate-end">{now ? `${now.verb} ${cut(rel(root, now.path), cols - 16)}` : 'Claude is not touching a file right now'}</Text>
      </Box>,
      <Text key="t-title" bold>Touched in this chat · {plural(touched.length, 'file')} · {edits} changed</Text>,
    ]
    if (touched.length === 0) parts.push(<Text key="t-none" dimColor>Nothing yet. Files show up here as Claude reads or changes them.</Text>)
    for (const t of touched.slice(0, 15)) {
      parts.push(
        <Text key={`t-${t.path}`} wrap="truncate-end">
          <Text color={t.edits ? STATUS.warn : STATUS.info}>{t.edits ? '✎' : '◦'}</Text> {cut(rel(root, t.path), cols - 18)} <Text dimColor>{t.edits ? `${t.edits} edit${t.edits === 1 ? '' : 's'}` : `read ${t.reads}×`}</Text>
        </Text>,
      )
    }
    if (showTree && tree.length) {
      parts.push(
        <Box key="tr-head" flexDirection="row" columnGap={1}>
          <Text bold>Project</Text>
          <Button key="tr-refresh" plain dimColor label="Refresh" onPress={() => buildTree($)} />
        </Box>,
      )
      for (const n of tree) {
        const isOpen = open.includes(n.path) || n.depth < 1 || n.changed === '•'
        const label = `${'  '.repeat(n.depth)}${n.dir ? (isOpen ? '▾ ' : '▸ ') : '  '}${n.name}${n.dir ? '/' : ''}`
        const color = codeColor(n.changed)
        const row = (
          <Text color={color} dimColor={!color && !n.dir} bold={n.dir} wrap="truncate-end">
            {cut(label, cols - 10)} {codeWord(n.changed) ? <Text dimColor>{codeWord(n.changed)}</Text> : null}
          </Text>
        )
        parts.push(
          n.dir ? (
            <Button key={`d-${n.path}`} plain onPress={async () => {
              await $.state.set(OPEN, isOpen ? open.filter(p => p !== n.path) : [...open, n.path])
              await buildTree($)
            }}>
              {row}
            </Button>
          ) : (
            <Box key={`f-${n.path}`}>{row}</Box>
          ),
        )
      }
      if (tree.length >= MAX_NODES) parts.push(<Text key="tr-more" dimColor>Showing the first {MAX_NODES} items.</Text>)
    }
    return roomy(<Box flexDirection="column" width={cols}>{parts}</Box>, e.surface)
  })
}
