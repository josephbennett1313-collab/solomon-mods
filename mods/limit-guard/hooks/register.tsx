// Limit Guard (Solomon Mods): stops the three things that burn plan limits fastest.
// - Helpers: more than 6 helper agents started for one message asks first.
// - Loops: the same shell command failing 3 times in a row is stopped, and Claude is told to rethink.
// - Size: reading a file over 2 MB asks first (it fills the context window).
// Each part switches off in /mods. /limits shows the counts. Written for Solomon Mods.

import type { EngineInterface, Register } from 'claude-code'

import { log, partOn, plural } from './suite'

const NAME = 'limit-guard'
const MAX_HELPERS = 6
const MAX_FAILS = 3
const MAX_BYTES = 2_000_000

let helpersThisMessage = 0
let lastFail = ''
let failStreak = 0
const stats = { helpersHeld: 0, loopsStopped: 0, bigReads: 0 }

async function sizeOf($: EngineInterface, path: string) {
  try {
    const r = await $.process.run(['stat', '-f', '%z', path])
    return Number.parseInt(String(r.stdout ?? '').trim(), 10) || 0
  } catch {
    return 0
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'limits', description: 'Limit Guard: helpers, retry loops and big files it caught in this chat' })
    return next(e)
  })

  on('command.run', { command: 'limits' }, async () => ({
    text: [
      `Limit Guard in this chat:`,
      `- Helpers started for the last message: ${helpersThisMessage} (asks past ${MAX_HELPERS}); held ${plural(stats.helpersHeld, 'time')}`,
      `- Retry loops stopped: ${stats.loopsStopped} (after ${MAX_FAILS} identical failures)`,
      `- Big file reads asked about: ${stats.bigReads} (over ${MAX_BYTES / 1_000_000} MB)`,
    ].join('\n'),
  }))

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && (e.origin.kind === 'composer' || e.origin.kind === 'bridge')) helpersThisMessage = 0
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    if (!(await partOn($, NAME, 'helpers'))) return next(e)
    helpersThisMessage += 1
    if (helpersThisMessage > MAX_HELPERS) {
      const pick = await $.ui.ask(`Limit Guard: this would be helper number ${helpersThisMessage} for one message. Each one uses your plan. Start it?`, ['Start it', 'Stop here']).catch(() => 'Stop here')
      if (pick !== 'Start it') {
        stats.helpersHeld += 1
        return { deny: `Limit Guard: Joseph capped helpers for this message at ${helpersThisMessage - 1}. Finish with the helpers already running.` }
      }
    }
    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!(await partOn($, NAME, 'loops'))) return next(e)
    const key = e.command.trim()
    if (key === lastFail && failStreak >= MAX_FAILS) {
      stats.loopsStopped += 1
      await log($, NAME, `stopped loop: ${key.slice(0, 160)}`)
      $.ui.toast('Limit Guard stopped a command that failed 3 times in a row.')
      failStreak = 0
      lastFail = ''
      return { deny: `Limit Guard: this exact command failed ${MAX_FAILS} times in a row. Stop retrying it. Read the error, find the cause, and try a different approach, or ask Joseph.` }
    }
    const r = await next(e)
    if (r.deny === undefined && r.isError === true) {
      failStreak = key === lastFail ? failStreak + 1 : 1
      lastFail = key
    } else if (r.deny === undefined) {
      failStreak = 0
      lastFail = ''
    }
    return r
  })

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (!(await partOn($, NAME, 'size')) || e.limit) return next(e)
    const bytes = await sizeOf($, e.file_path)
    if (bytes > MAX_BYTES) {
      stats.bigReads += 1
      const mb = (bytes / 1_000_000).toFixed(1)
      const pick = await $.ui.ask(`Limit Guard: ${e.file_path.split('/').pop()} is ${mb} MB. Reading it all fills much of the chat's memory. Read it anyway?`, ['Read part of it', 'Read it all', 'Skip it']).catch(() => 'Skip it')
      if (pick === 'Read it all') return next(e)
      if (pick === 'Read part of it') return next({ ...e, limit: 400 })
      return { deny: `Limit Guard: ${e.file_path} is ${mb} MB, so Joseph skipped reading it. Search it with Grep, or read a small part with offset and limit.` }
    }
    return next(e)
  })
}
