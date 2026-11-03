// All Tasks: every chat's task list in one view. Each chat's Mission Control saves its list to
// ~/.claude/mods-state/plan-<session>.json, so this tab reads them all: open work first, then
// lists finished in the last week. Written for Solomon Mods.

import type { EngineInterface } from 'claude-code'

import { STATUS, barCells, cut, homeOf } from './suite'

const RED = { light: '#FF9A6B', mid: '#F0603A', deep: '#C2410C' }
const WEEK = 7 * 24 * 3600_000

type Saved = { title?: string; steps?: { text: string; status: string }[]; updatedAt?: string }
type Row = { sid: string; title: string; done: number; total: number; now: string; next: string; at: number }

function ago(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  return `${Math.round(h / 24)} d ago`
}

export async function readAllTasks($: EngineInterface): Promise<Row[]> {
  const dir = `${homeOf($)}/.claude/mods-state`
  let files: { name: string; kind: string }[] = []
  try {
    files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && /^plan-.+\.json$/.test(f.name))
  } catch {
    return []
  }
  const now = await $.clock.now()
  const rows: Row[] = []
  for (const f of files) {
    try {
      const p = JSON.parse(String(await $.fs.read(`${dir}/${f.name}`))) as Saved
      const steps = p.steps ?? []
      if (!steps.length) continue
      const at = p.updatedAt ? Date.parse(p.updatedAt) : 0
      if (!at || now - at > WEEK) continue
      rows.push({
        sid: f.name.slice(5, -5),
        title: p.title?.trim() || 'Plan',
        done: steps.filter(s => s.status === 'completed').length,
        total: steps.length,
        now: steps.find(s => s.status === 'in_progress')?.text ?? '',
        next: steps.find(s => s.status === 'pending')?.text ?? '',
        at,
      })
    } catch {
      // A half-written file is skipped this time.
    }
  }
  return rows.sort((a, b) => b.at - a.at)
}

export async function allTasksView($: EngineInterface, els: Record<string, any>, width: number, sessionId: string) {
  const { Box, Text } = els
  const rows = await readAllTasks($)
  const now = await $.clock.now()
  const open = rows.filter(r => r.done < r.total)
  const finished = rows.filter(r => r.done === r.total)
  const barW = Math.max(8, Math.min(30, width - 22))
  const card = (r: Row) => {
    const { fill, rest } = barCells(r.done / r.total, barW)
    const mine = r.sid === sessionId
    const isDone = r.done === r.total
    return (
      <Box key={`task-${r.sid}`} flexDirection="column" borderStyle="round" borderColor={mine ? RED.mid : undefined} paddingX={1} width={width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            <Text color={isDone ? STATUS.good : RED.mid}>● </Text>
            {cut(r.title, width - 22)}
          </Text>
          <Text dimColor>{mine ? 'this chat' : ago(now - r.at)}</Text>
        </Box>
        <Text>
          {fill.map((_, i) => (
            <Text key={`c${i}`} color={i < fill.length / 2 ? RED.light : RED.mid}>█</Text>
          ))}
          <Text dimColor>{'░'.repeat(rest)}</Text>
          <Text bold color={isDone ? STATUS.good : RED.deep}>{` ${r.done}/${r.total}`}</Text>
          <Text dimColor>{` ${Math.round((r.done / r.total) * 100)}%`}</Text>
        </Text>
        {r.now ? <Text wrap="truncate-end"><Text color={RED.mid}>Now: </Text>{r.now}</Text> : null}
        {!r.now && r.next ? <Text dimColor wrap="truncate-end">{`Next: ${r.next}`}</Text> : null}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={width} gap="xs">
      <Text dimColor size="caption">{`OPEN · ${open.length}`}</Text>
      {open.length ? open.map(card) : <Text dimColor>No chat has open tasks. A list shows up here when any chat keeps a task list.</Text>}
      {finished.length ? <Text dimColor size="caption">{`FINISHED THIS WEEK · ${finished.length}`}</Text> : null}
      {finished.slice(0, 10).map(card)}
    </Box>
  )
}
