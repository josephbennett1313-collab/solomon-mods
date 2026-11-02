// Goal Meter (after Nate Herk's idea): Claude Code's own /goal keeps a chat going until a
// condition is met. This part shows that goal above the prompt with the time since it was set,
// how many rounds Claude has taken at it, and a checkmark per plan step.
// It only watches: /goal itself, and Claude's ProposeGoal tool, do the work.

import type { EngineInterface, Register } from 'claude-code'

import type { Goal } from '../types'
import { GRADIENT, LIVE, STATUS, clockTime, cut, isPartOn, oneLine, readSwitches } from './suite'

type On = Parameters<Register>[0]

const NAME = 'mission-control'
const GOAL = { plugin: 'mission-control', key: 'goal' } as const
const TICK = { plugin: 'mission-control', key: 'goalTick' } as const

let goal: Goal | null = null
let ticker: { cancel: () => void } | null = null

async function save($: EngineInterface) {
  await $.state.set(GOAL, goal ? { ...goal } : null)
  if (goal && !goal.endedAt) {
    ticker ??= $.clock.every(1000, () => {
      void $.state.set(TICK, Date.now()).catch(() => undefined)
    })
  } else {
    ticker?.cancel()
    ticker = null
  }
}

async function setGoal($: EngineInterface, condition: string) {
  const text = oneLine(condition)
  if (!text) return
  goal = { condition: text, startedAt: await $.clock.now(), endedAt: 0, rounds: 0, met: false }
  await save($)
}

async function endGoal($: EngineInterface, met: boolean) {
  if (!goal || goal.endedAt) return
  goal = { ...goal, endedAt: await $.clock.now(), met }
  await save($)
  try {
    $.ui.toast(met ? `◎ Goal met in ${clockTime(goal.endedAt - goal.startedAt)}: ${cut(goal.condition, 80)}` : '◎ Goal cleared.')
  } catch {
    // A toast is only a hint.
  }
}

const MET = /\bgoal (?:is )?(?:met|complete|achieved)\b|condition (?:is )?met/i

/** A reload or resume carries on with the goal. Called from Mission Control's session.start. */
export async function goalStart($: EngineInterface) {
  const { value } = await $.state.get(GOAL)
  if (value) {
    goal = value
    await save($)
  }
}

/** One more round at the goal. Called from Mission Control's turn.complete. */
export async function goalTurn($: EngineInterface, e: { agentId?: string }) {
  if (goal && !goal.endedAt && !e.agentId) {
    goal = { ...goal, rounds: goal.rounds + 1 }
    await save($)
  }
}

export function registerGoal(on: On) {
  // The built-in /goal: watch it, never answer it.
  on('command.run', { command: 'goal' }, async ($, e, next) => {
    try {
      const args = (e.args ?? '').trim()
      if (/^(clear|stop|cancel|off)$/i.test(args)) await endGoal($, false)
      else if (args) await setGoal($, args)
    } catch {
      // Watching must never break /goal.
    }
    return next(e)
  })

  // Claude proposed a goal and it was set (or asked for).
  on('tool.call', { tool: 'ProposeGoal' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && r.isError !== true && !e.agentId) {
      const condition = String((e as unknown as { condition?: unknown }).condition ?? '')
      await setGoal($, condition).catch(() => undefined)
    }
    return r
  })

  // The goal's own Stop hook reports "met" as a notice in the chat.
  on('session.append', async ($, e, next) => {
    const r = await next(e)
    if (goal && !goal.endedAt && (e.door === 'notice' || e.door === 'hook-context')) {
      const content = (e.message as { content?: unknown }).content
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(b => (b as { text?: string }).text ?? '').join(' ') : ''
      if (MET.test(text)) await endGoal($, true).catch(() => undefined)
    }
    return r
  })
}

/** The goal row for the band, or null. Steps come from the plan the task bar draws. */
export async function goalRow(
  $: EngineInterface,
  els: { Box: any; Text: any },
  cols: number,
  steps: { status: string }[],
): Promise<unknown> {
  const json = await readSwitches($)
  if (!isPartOn(json, NAME, 'goal')) return null
  const { value: g = null } = await $.state.get(GOAL)
  if (!g) return null
  // A finished goal stays on the band for a minute, then goes.
  const now = await $.clock.now()
  if (g.endedAt && now - g.endedAt > 60_000) return null
  await $.state.get(TICK)
  const { Box, Text } = els
  const time = clockTime((g.endedAt || now) - g.startedAt)
  const checks = steps.slice(0, 12).map(st => (st.status === 'completed' ? '✓' : st.status === 'in_progress' ? '◐' : '○')).join('')
  const meta = [time, g.rounds ? `round ${g.rounds + (g.endedAt ? 0 : 1)}` : 'round 1', checks].filter(Boolean).join('  ')
  const state = g.endedAt ? (g.met ? 'Goal met' : 'Goal cleared') : 'Goal'
  const color = g.endedAt ? (g.met ? STATUS.good : STATUS.warn) : LIVE
  const room = Math.max(10, (cols || 80) - state.length - meta.length - 6)
  return (
    <Box key="goal-row" flexDirection="row" gap={1}>
      <Text color={GRADIENT[2]}>◎</Text>
      <Text bold color={color}>{state}</Text>
      <Box flexGrow={1} flexShrink={1}>
        <Text wrap="truncate-end">{cut(g.condition, room)}</Text>
      </Box>
      <Text dimColor tabular>
        {meta}
      </Text>
    </Box>
  )
}
