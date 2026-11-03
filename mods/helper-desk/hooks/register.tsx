// Helper Desk (Solomon Mods): a tab beside the chat that opens when helpers start.
// - A crab card for every helper agent, each its own colour, with a clear title, what it is doing,
//   its tokens and its time.
// - This chat's total cost, all helpers' tokens and time.
// - A to-do list that is saved across chats (/todo <text> adds one).
// - The dock: how many helpers may run at once and which model they use.
// Written for Solomon Mods; the ideas are credited in SOURCES.md.

import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Dock, Helper, Todo } from '../types'
import { ACCENT, STATUS, cut, duration, crabGlyph, crabSvg, log, money, paletteAt, partOn, roomy, tokenText } from './suite'

const NAME = 'helper-desk'
const PANE = 'helper-desk'
const HELPERS = { plugin: 'helper-desk', key: 'helpers' } as const
const TODOS = { plugin: 'helper-desk', key: 'todos' } as const
const DOCK = { plugin: 'helper-desk', key: 'dock' } as const
const NOTE = { plugin: 'helper-desk', key: 'note' } as const
const USD = { plugin: 'helper-desk', key: 'usd' } as const
const STORE_TODOS = 'todos'
const STORE_DOCK = 'dock'
const MODELS: { label: string; id: string }[] = [
  { label: 'Same as chat', id: '' },
  { label: 'Haiku', id: 'claude-haiku-5-5' },
  { label: 'Sonnet', id: 'claude-sonnet-5-5' },
  { label: 'Opus', id: 'claude-opus-5-5' },
]
const LIVE = new Set(['pending', 'running', 'waiting'])
let opened = false

/** "explore the auth folder" -> "Explore the auth folder". */
const tidy = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Helper'
}

async function helpers($: EngineInterface) {
  return (await $.state.get(HELPERS)).value ?? []
}

async function saveTodos($: EngineInterface, todos: Todo[]) {
  await $.state.set(TODOS, todos)
  await $.store.set(STORE_TODOS, todos)
}

async function dockOf($: EngineInterface): Promise<Dock> {
  return (await $.state.get(DOCK)).value ?? { size: 0, model: '' }
}

async function setDock($: EngineInterface, d: Dock) {
  await $.state.set(DOCK, d)
  await $.store.set(STORE_DOCK, d)
}

/** Brings each card's status in line with the engine's own list of agents. */
async function sync($: EngineInterface) {
  try {
    const list = await $.agent.list()
    const byId = new Map(list.map(a => [a.id, a]))
    const now = Date.now()
    const cur = await helpers($)
    let changed = false
    const next = cur.map(h => {
      const a = byId.get(h.id)
      if (!a || a.status === h.status) return h
      changed = true
      return { ...h, status: a.status, endedAt: LIVE.has(a.status) ? 0 : h.endedAt || now }
    })
    // Helpers this mod did not see start (started before it loaded) still get a card.
    for (const a of list) {
      if (cur.some(h => h.id === a.id)) continue
      changed = true
      next.push({ id: a.id, title: tidy(a.description || a.name || a.type), type: a.type, color: paletteAt(next.length + 1), status: a.status, startedAt: now, endedAt: LIVE.has(a.status) ? 0 : now, tokens: 0, ms: 0, model: '' })
    }
    if (changed) await $.state.set(HELPERS, next)
    const u = await $.session.usage()
    await $.state.set(USD, u.cost?.usd ?? 0)
  } catch (err) {
    await log($, NAME, `sync: ${String(err)}`)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.state.set(TODOS, ((await $.store.get(STORE_TODOS)) as Todo[] | undefined) ?? [])
    await $.state.set(DOCK, ((await $.store.get(STORE_DOCK)) as Dock | undefined) ?? { size: 0, model: '' })
    await $.command.register({ name: 'helpers', description: 'Helper Desk: open the helpers, cost and to-do tab' })
    await $.command.register({ name: 'todo', description: 'Add a to-do to Helper Desk: /todo <text>' })
    await $.command.register({ name: 'team', description: 'Helper Desk: set how many helpers may run at once, /team 3 (0 = no limit)' })
    $.clock.every(3000, () => void sync($))
    return next(e)
  })

  on('command.run', { command: 'helpers' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Helper Desk' })
    return { text: 'Helper Desk is open.' }
  })

  on('command.run', { command: 'todo' }, async ($, e) => {
    const text = String(e.args ?? '').trim()
    if (!text) return { text: 'Write the to-do after the command, like /todo send the invoice.' }
    const todos = (await $.state.get(TODOS)).value ?? []
    await saveTodos($, [...todos, { id: `t${Date.now()}`, text, done: false, at: Date.now() }])
    return { text: `Added to Helper Desk: ${text}` }
  })

  // The dock: tell Claude how big a team to split the job across.
  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!(await partOn($, NAME, 'dock'))) return r
    const dock = await dockOf($)
    if (dock.size < 1) return r
    return { sections: [...r.sections, { id: 'helper-desk:team', scope: 'session' as const, text: `Team size: the user chose a team of ${dock.size} helper agent${dock.size === 1 ? '' : 's'} for their next request. Split the work into up to ${dock.size} independent pieces and run them as helpers at the same time where the pieces do not depend on each other. Never run more than ${dock.size} at once.${dock.model ? ` Use the model ${dock.model} for them.` : ''}` }] }
  })

  on('command.run', { command: 'team' }, async ($, e) => {
    const n = Number.parseInt(String(e.args ?? ''), 10)
    if (!Number.isFinite(n) || n < 0 || n > 100) return { text: 'Give a number from 0 (no limit) to 100, like /team 3.' }
    await setDock($, { ...(await dockOf($)), size: n })
    return { text: n ? `Up to ${n} helpers at once.` : 'No limit on helpers.' }
  })

  // The dock: hold the team size and give helpers the chosen model.
  on('agent.spawn', async ($, e, next) => {
    if (!(await partOn($, NAME))) return next(e)
    const dock = await dockOf($)
    const dockOn = await partOn($, NAME, 'dock')
    if (dockOn && dock.size > 0) {
      const running = (await helpers($)).filter(h => LIVE.has(h.status)).length
      if (running >= dock.size) return { deny: `Helper Desk allows ${dock.size} helpers at once and ${running} are running. Wait for one to finish, or raise the limit with /team.` }
    }
    const r = await next(dockOn && dock.model && !e.model ? { ...e, model: dock.model } : e)
    if (r.agentId) {
      const cur = await helpers($)
      await $.state.set(HELPERS, [
        ...cur.filter(h => h.id !== r.agentId),
        { id: r.agentId, title: tidy(e.description), type: e.subagentType || 'general-purpose', color: paletteAt(cur.length + 1), status: 'running', startedAt: Date.now(), endedAt: 0, tokens: 0, ms: 0, model: r.model },
      ])
    }
    if (r.agentId && !opened && (await partOn($, NAME, 'autoopen'))) {
      opened = true
      await $.ui.open({ id: PANE, title: 'Helper Desk' }).catch(err => log($, NAME, `open: ${String(err)}`))
    }
    return r
  })

  // Each helper turn adds its tokens and time to its card.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) {
      const used = e.usage ? e.usage.input_tokens + e.usage.output_tokens + e.usage.cache_read_input_tokens + e.usage.cache_creation_input_tokens : 0
      const cur = await helpers($)
      if (cur.some(h => h.id === e.agentId)) await $.state.set(HELPERS, cur.map(h => (h.id === e.agentId ? { ...h, tokens: h.tokens + used, ms: h.ms + e.durationMs } : h)))
    }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const desktop = (e.surface === 'desktop' || e.surface === 'mobile') && 'Svg' in ui
    const cols = Math.max(30, e.props.bodyColumns)
    if (!(await partOn($, NAME))) return <Text dimColor>Helper Desk is switched off. Turn it on in /mods.</Text>
    const list = await helpers($)
    const todos = (await $.state.get(TODOS)).value ?? []
    const dock = await dockOf($)
    const usd = (await $.state.get(USD)).value ?? 0
    const note = (await $.state.get(NOTE)).value ?? ''
    const showCards = await partOn($, NAME, 'cards')
    const showTodos = await partOn($, NAME, 'todos')
    const showDock = await partOn($, NAME, 'dock')
    const tokens = list.reduce((s, h) => s + h.tokens, 0)
    const ms = list.reduce((s, h) => s + (h.ms || ((h.endedAt || Date.now()) - h.startedAt)), 0)
    const running = list.filter(h => LIVE.has(h.status)).length
    const fox = (color: string, id: string, still: boolean) =>
      desktop ? <ui.Svg source={crabSvg(30, color, { id, still })} alt="Claude crab" width={30} height={22} /> : <Text color={color}>{crabGlyph()}</Text>
    const stat = (label: string, value: string, color?: string) => (
      <Box key={`s-${label}`} flexDirection="column" borderStyle="round" paddingX={1} flexGrow={1}>
        <Text dimColor size="caption">{label}</Text>
        <Text bold color={color}>{value}</Text>
      </Box>
    )
    const statusColor = (s: string) => (LIVE.has(s) ? STATUS.info : s === 'completed' || s === 'idle' ? STATUS.good : STATUS.bad)
    const statusWord = (s: string) => ({ pending: 'starting', running: 'working', waiting: 'waiting', idle: 'idle', completed: 'done', failed: 'failed', killed: 'stopped' })[s] ?? s

    const parts: RenderChildren[] = [
      <Box key="head" flexDirection="row" alignItems="center" columnGap={1}>
        {fox(ACCENT, 'hd-main', running === 0)}
        <Text bold size="heading">Helper Desk</Text>
        <Text dimColor>{running ? `${running} working` : 'all quiet'}</Text>
      </Box>,
      <Box key="stats" flexDirection="row" columnGap={1} width={cols}>
        {stat('Chat cost', money(usd), ACCENT)}
        {stat('Helper tokens', tokenText(tokens))}
        {stat('Helper time', duration(ms / 60_000))}
      </Box>,
    ]
    if (note) parts.push(<Text key="note" color={STATUS.good}>{cut(note, cols)}</Text>)

    if (showCards) {
      parts.push(<Text key="h-title" bold>Helpers · {list.length}</Text>)
      if (list.length === 0) parts.push(<Text key="h-none" dimColor>No helpers yet. When Claude sends work to a helper agent, its card appears here.</Text>)
      for (const h of [...list].reverse().slice(0, 12)) {
        const live = LIVE.has(h.status)
        parts.push(
          <Box key={`h-${h.id}`} flexDirection="row" columnGap={1} borderStyle="round" borderColor={h.color} paddingX={1} width={cols}>
            {fox(h.color, `hd-${h.id.slice(0, 8)}`, !live)}
            <Box flexDirection="column" flexGrow={1}>
              <Text bold wrap="truncate-end">{cut(h.title, cols - 12)}</Text>
              <Text dimColor wrap="truncate-end">
                <Text color={statusColor(h.status)}>● {statusWord(h.status)}</Text> · {h.type}{h.model ? ` · ${h.model.replace(/^claude-/, '')}` : ''} · {tokenText(h.tokens)} tokens · {duration(((h.ms || (h.endedAt || Date.now()) - h.startedAt)) / 60_000)}
              </Text>
            </Box>
          </Box>,
        )
      }
    }

    if (showTodos) {
      const open = todos.filter(t => !t.done)
      parts.push(<Text key="t-title" bold>To-do · {open.length} open</Text>)
      if (todos.length === 0) parts.push(<Text key="t-none" dimColor>Nothing yet. Type /todo and the task to add one. It stays here in every chat.</Text>)
      for (const t of [...open, ...todos.filter(x => x.done).slice(-5)]) {
        parts.push(
          <Box key={`t-${t.id}`} flexDirection="row" columnGap={1} width={cols}>
            <Button key={`tick-${t.id}`} plain label={t.done ? '☑' : '☐'} onPress={() => saveTodos($, todos.map(x => (x.id === t.id ? { ...x, done: !x.done } : x)))} />
            <Box flexGrow={1}>
              <Text dimColor={t.done} strikethrough={t.done} wrap="truncate-end">{cut(t.text, cols - 10)}</Text>
            </Box>
            <Button key={`del-${t.id}`} plain label="×" onPress={() => saveTodos($, todos.filter(x => x.id !== t.id))} />
          </Box>,
        )
      }
      if (todos.some(t => t.done)) parts.push(<Button key="t-clear" plain dimColor label="Clear finished" onPress={() => saveTodos($, todos.filter(t => !t.done))} />)
    }

    if (showDock) {
      parts.push(
        <Box key="dock" flexDirection="column" borderStyle="round" paddingX={1} width={cols}>
          <Text bold>Dock</Text>
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text dimColor>Helpers at once</Text>
            <Button key="d-minus" label="−" onPress={() => setDock($, { ...dock, size: Math.max(0, dock.size - 1) })} />
            <Text bold>{dock.size ? String(dock.size) : 'no limit'}</Text>
            <Button key="d-plus" label="+" onPress={() => setDock($, { ...dock, size: Math.min(100, dock.size + 1) })} />
            {[1, 3, 5, 10, 25, 100].map(n => <Button key={`d-${n}`} plain variant={dock.size === n ? 'primary' : undefined} label={String(n)} onPress={() => setDock($, { ...dock, size: n })} />)}
          </Box>
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text dimColor>Helper model</Text>
            {MODELS.map(m => (
              <Button key={`m-${m.label}`} variant={dock.model === m.id ? 'primary' : undefined} label={m.label} onPress={async () => {
                await setDock($, { ...dock, model: m.id })
                await $.state.set(NOTE, `New helpers use ${m.label === 'Same as chat' ? 'the chat model' : m.label}.`)
              }} />
            ))}
          </Box>
        </Box>,
      )
    }
    return roomy(<Box flexDirection="column" width={cols}>{parts}</Box>, e.surface)
  })
}
