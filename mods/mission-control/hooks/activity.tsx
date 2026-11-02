// Activity: every step of the main chat in plain English, with an estimate of the human
// time it saved. From OneWave AI's Agent Narrator (MIT); the phrasing rules live in narrate.ts.
// Helper agents have their own cards on the Helpers tab, so only the main chat is narrated here.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ActivityRun, ActivityStep } from '../types'
import { narrate, testNote } from './narrate'
import { GRADIENT, LIVE, STATUS, clockTime, cut, duration, isPartOn, readSwitches } from './suite'

const NAME = 'mission-control'
const KEEP = 120
const RING = ['◜', '◝', '◞', '◟']

const feed = atom({ plugin: 'mission-control', key: 'feed' } as const, [] as ActivityStep[])
const run = atom({ plugin: 'mission-control', key: 'run' } as const, {
  isRunning: false,
  startedAt: 0,
  endedAt: 0,
  steps: 0,
  savedMinutes: 0,
} as ActivityRun)
const frameAtom = atom({ plugin: 'mission-control', key: 'frame' } as const, 0)

let frame = 0
let spinner: { cancel: () => void } | null = null

async function partsOf($: EngineInterface) {
  const json = await readSwitches($)
  return { on: json[NAME] !== false && isPartOn(json, NAME, 'activity'), smart: isPartOn(json, NAME, 'smart-words', false) }
}

const brief = (input: Record<string, unknown>) => {
  const keep = ['file_path', 'path', 'pattern', 'command', 'url', 'query', 'description']
  return JSON.stringify(Object.fromEntries(keep.filter(k => typeof input[k] === 'string').map(k => [k, String(input[k]).slice(0, 120)]))).slice(0, 400)
}

/** Optional: a small model rewrites the line in warmer words. Off unless switched on (it costs a little). */
async function polish($: EngineInterface, id: string, text: string, detail: string) {
  const r = await $.model.complete({
    model: 'haiku',
    effort: 'low',
    maxTokens: 60,
    system:
      'You narrate an AI agent working, for a non-technical business owner watching. Rewrite the step as one short present-tense sentence, under 12 words, no jargon, no file extensions, no emojis, no quotes.',
    prompt: `Step: ${text}\nTechnical detail: ${detail.slice(0, 400)}`,
  })
  if (!r.isAnswered) return
  const line = r.text.trim().split('\n')[0]?.replace(/^["']|["']$/g, '')
  if (line) await update($, feed, list => list.map(s => (s.id === id ? { ...s, text: line } : s)))
}

function spin($: EngineInterface, on: boolean) {
  if (on) {
    spinner ??= $.clock.every(250, () => {
      frame += 1
      void update($, frameAtom, () => frame).catch(() => undefined)
    })
  } else {
    spinner?.cancel()
    spinner = null
  }
}

/** A new prompt starts the clock. Called from Mission Control's one prompt.submit hook. */
export async function activityPrompt($: EngineInterface) {
  if (!(await partsOf($)).on) return
  const now = await $.clock.now()
  await update($, run, x => ({ ...x, isRunning: true, startedAt: x.isRunning ? x.startedAt : now, endedAt: 0 }))
  spin($, true)
}

type Ran = { deny?: string; isError?: boolean; result?: unknown }

/** Wraps one main-chat tool call: a line before it runs, a mark after. */
export async function activityTool<R extends Ran>($: EngineInterface, e: { tool: unknown; tool_use_id: string; agentId?: string }, next: () => Promise<R>): Promise<R> {
  if (e.agentId || String(e.tool).startsWith('mcp__mission-control__')) return next()
  const p = await partsOf($)
  if (!p.on) return next()
  const tool = String(e.tool)
  const input = e as unknown as Record<string, unknown>
  const n = narrate(tool, input)
  const step: ActivityStep = { id: e.tool_use_id, text: n.text, note: '', status: 'running', at: await $.clock.now(), minutes: n.minutes }
  await update($, feed, list => [...list, step].slice(-KEEP))
  await update($, run, x => ({ ...x, steps: x.steps + 1 }))
  if (p.smart) void polish($, step.id, n.text, `${tool} ${brief(input)}`).catch(() => undefined)
  const ran = await next()
  const out = ran.result as { stdout?: unknown; stderr?: unknown } | undefined
  const stdout = typeof out?.stdout === 'string' ? `${out.stdout}\n${String(out.stderr ?? '')}` : ''
  const failed = ran.deny !== undefined || ran.isError === true
  const tests = testNote(stdout)
  const note = tests ?? (failed ? 'did not work, trying another way' : '')
  await update($, feed, list => list.map(s => (s.id === step.id ? { ...s, status: (failed ? 'failed' : 'done') as ActivityStep['status'], note } : s)))
  if (!failed || tests) await update($, run, x => ({ ...x, savedMinutes: x.savedMinutes + step.minutes }))
  return ran
}

/** The main chat's turn ended: stop the clock. */
export async function activityTurn($: EngineInterface, e: { agentId?: string }) {
  if (e.agentId) return
  const now = await $.clock.now()
  await update($, run, x => ({ ...x, isRunning: false, endedAt: now }))
  spin($, false)
}

/** The Activity tab of the Mission Control pane. */
export async function activityView($: EngineInterface, els: { Box: any; Text: any }, width: number, rows: number) {
  const { Box, Text } = els
  const { on } = await partsOf($)
  if (!on) return <Text dimColor>Activity is switched off. Turn it on in /mods.</Text>
  const r = await read($, run)
  const list = await read($, feed)
  const f = await read($, frameAtom)
  const now = await $.clock.now()
  const time = r.startedAt ? clockTime((r.isRunning ? now : r.endedAt || now) - r.startedAt) : '0:00'
  const room = Math.max(3, rows - 9)
  const row = (s: ActivityStep) => {
    const live = s.status === 'running'
    const mark = live ? RING[f % RING.length]! : s.status === 'failed' ? '×' : '✓'
    const color = live ? LIVE : s.status === 'failed' ? STATUS.warn : STATUS.good
    return (
      <Box key={`a-${s.id}`} flexDirection="row" width={width}>
        <Box width={3} flexShrink={0}>
          <Text color={color} bold={live}>
            {mark}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text bold={live} dimColor={!live && s.status === 'done'} wrap="wrap">
            {s.text}
            {s.note ? <Text color={s.status === 'failed' ? STATUS.warn : LIVE}>{`  ·  ${s.note}`}</Text> : null}
          </Text>
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={width} gap="xs">
      <Box flexDirection="row" justifyContent="space-between" width={width}>
        <Text bold color={r.isRunning ? LIVE : GRADIENT[1]}>
          {r.isRunning ? `${RING[f % RING.length]} Working` : r.steps ? 'Done' : 'Ready'}
        </Text>
        <Text dimColor tabular>{`step ${r.steps} · ${time}`}</Text>
      </Box>
      <Box flexDirection="column" borderStyle="round" paddingX={1} width={width}>
        <Text dimColor size="caption">
          ESTIMATED HUMAN TIME SAVED THIS CHAT
        </Text>
        <Text bold size="heading" color={GRADIENT[1]}>
          {duration(r.savedMinutes)}
        </Text>
      </Box>
      {list.length ? null : <Text dimColor>Steps show here in plain English as Claude works.</Text>}
      {list.slice(-room).map(row)}
      {list.length > room ? <Text dimColor>{cut(`${list.length - room} earlier steps not shown`, width)}</Text> : null}
    </Box>
  )
}
