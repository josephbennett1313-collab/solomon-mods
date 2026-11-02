// Replay: the last turn's file edits, one diff at a time.
// After Anthropic's Replay Theater sample (Apache-2.0, Copyright 2026 Anthropic PBC), with Ben AI's
// switchboard change. Rewritten for Edit Rewind in JSX with the Solomon Mods tokens; the diff
// logic (LCS with one line of context, capped steps) follows the original.

import type { EngineInterface } from 'claude-code'

import { GRADIENT, LIVE, STATUS } from './suite'

const MAX_DIFF_LINES = 12
const MAX_LCS_LINES = 400
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit'])

export type DiffLine = { op: '+' | '-' | ' ' | '~'; t: string }
export type ReplayStep = { tool: string; file: string; diff: DiffLine[]; note: string }

/** Module state: `pending` fills during a turn; `steps` is the last finished turn's. */
export const replayState = {
  pending: [] as ReplayStep[],
  steps: [] as ReplayStep[],
  index: 0,
  /** The timeline step number just before the turn began: Undo this turn restores to it. */
  base: -1,
  nextBase: -1,
  tab: 'replay' as 'replay' | 'timeline',
}

function relPath(cwd: string, path: unknown) {
  if (typeof path !== 'string' || !path) return '(unknown file)'
  return cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

function splitLines(text: unknown) {
  if (text === undefined || text === null || text === '') return []
  const lines = String(text).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function trimContext(lines: DiffLine[]): DiffLine[] {
  if (!lines.some(l => l.op !== ' ')) return lines.slice(0, MAX_DIFF_LINES)
  const near = (k: number) => lines[k] !== undefined && lines[k]!.op !== ' '
  const out: DiffLine[] = []
  let skipped = false
  lines.forEach((l, k) => {
    if (l.op !== ' ' || near(k - 1) || near(k + 1)) {
      if (skipped && out.length) out.push({ op: '~', t: '⋯' })
      out.push(l)
      skipped = false
    } else skipped = true
  })
  return out
}

export function diffLines(oldText: unknown, newText: unknown): DiffLine[] {
  const a = splitLines(oldText)
  const b = splitLines(newText)
  if (a.length > MAX_LCS_LINES || b.length > MAX_LCS_LINES) return [...a.map(t => ({ op: '-' as const, t })), ...b.map(t => ({ op: '+' as const, t }))]
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', t: a[i]! })
      i += 1
      j += 1
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: '-', t: a[i++]! })
    else out.push({ op: '+', t: b[j++]! })
  }
  while (i < n) out.push({ op: '-', t: a[i++]! })
  while (j < m) out.push({ op: '+', t: b[j++]! })
  return trimContext(out)
}

export function countChanges(diff: DiffLine[]) {
  let add = 0
  let del = 0
  for (const l of diff) {
    if (l.op === '+') add += 1
    else if (l.op === '-') del += 1
  }
  return { add, del }
}

/** Records one edit tool call into the turn's pending steps. Never throws. */
export async function recordEdit($: EngineInterface, e: Record<string, unknown>) {
  const tool = String(e.tool)
  if (!EDIT_TOOLS.has(tool)) return
  try {
    const cwd = await $.session.cwd().catch(() => '')
    const file = relPath(cwd, e.file_path)
    if (tool === 'Edit') {
      replayState.pending.push({ tool, file, diff: diffLines(e.old_string, e.new_string), note: e.replace_all ? 'replace all' : '' })
    } else if (tool === 'MultiEdit' && Array.isArray(e.edits)) {
      const edits = e.edits as { old_string?: string; new_string?: string }[]
      edits.forEach((ed, k) => replayState.pending.push({ tool, file, diff: diffLines(ed.old_string, ed.new_string), note: `edit ${k + 1} of ${edits.length}` }))
    } else if (tool === 'Write') {
      let before = ''
      let isNew = true
      if (typeof e.file_path === 'string' && (await $.fs.exists(e.file_path))) {
        before = String(await $.fs.read(e.file_path))
        isNew = false
      }
      replayState.pending.push({ tool, file, diff: diffLines(before, e.content), note: isNew ? 'new file' : 'rewrite' })
    }
  } catch {
    // Recording never stops the edit.
  }
}

/** A main-chat turn ended: its edits become the replay. True when there is a new replay. */
export function finishTurn() {
  if (!replayState.pending.length) return false
  replayState.steps = replayState.pending
  replayState.base = replayState.nextBase
  replayState.pending = []
  replayState.index = 0
  return true
}

export function readReplay() {
  return replayState
}

/** Prev and Next. True when the press was one of them. */
export function replayPress(element: string) {
  const total = replayState.steps.length
  if (element === 'prev') replayState.index = Math.max(0, replayState.index - 1)
  else if (element === 'next') replayState.index = Math.min(Math.max(0, total - 1), replayState.index + 1)
  else if (/^step-\d+$/.test(element)) replayState.index = Math.min(total - 1, Number(element.slice(5)))
  else return false
  return true
}

/** The Last turn tab. */
export function replayView(els: Record<string, any>, width: number, canUndo: boolean) {
  const { Box, Text, Button } = els
  const noop = () => undefined
  const total = replayState.steps.length
  if (!total) return <Text dimColor>No edits yet. When Claude changes files, each change shows here, one at a time.</Text>
  const k = Math.max(0, Math.min(replayState.index, total - 1))
  const step = replayState.steps[k]!
  const { add, del } = countChanges(step.diff)
  const shown = step.diff.slice(0, MAX_DIFF_LINES)
  const w = Math.max(30, width - 2)
  return (
    <Box flexDirection="column" width={width} gap="xs">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold>{`Change ${k + 1} of ${total}`}</Text>
        <Text>
          <Text color={STATUS.good}>{`+${add}`}</Text>
          <Text> </Text>
          <Text color={STATUS.bad}>{`-${del}`}</Text>
        </Text>
      </Box>
      <Box flexDirection="row" gap={0}>
        {replayState.steps.slice(0, 24).map((_, n) => (
          <Button key={`step-${n}`} plain onPress={noop}>
            <Text inverse={n === k} color={n === k ? LIVE : undefined} dimColor={n !== k}>{` ${n + 1} `}</Text>
          </Button>
        ))}
      </Box>
      <Text bold color={GRADIENT[1]} wrap="truncate-start">
        {step.file}
      </Text>
      <Text dimColor>{`${step.tool}${step.note ? ` · ${step.note}` : ''}`}</Text>
      <Box flexDirection="column" borderStyle="round" paddingX={1}>
        {shown.length ? (
          shown.map((l, n) => (
            <Text key={`d${n}`} mono color={l.op === '+' ? STATUS.good : l.op === '-' ? STATUS.bad : undefined} dimColor={l.op === ' ' || l.op === '~'} wrap="truncate-end">
              {`${l.op === '~' ? ' ' : l.op} ${l.t}`.slice(0, w)}
            </Text>
          ))
        ) : (
          <Text dimColor>(no line changes)</Text>
        )}
        {step.diff.length > MAX_DIFF_LINES ? <Text dimColor>{`… ${step.diff.length - MAX_DIFF_LINES} more lines`}</Text> : null}
      </Box>
      <Box flexDirection="row" gap={1}>
        <Button key="prev" label="◀ Prev" hotkey="p" onPress={noop} />
        <Button key="next" label="Next ▶" hotkey="n" onPress={noop} />
        {canUndo ? <Button key="undo-turn" label="Undo this turn" variant="secondary" onPress={noop} /> : null}
      </Box>
    </Box>
  )
}
