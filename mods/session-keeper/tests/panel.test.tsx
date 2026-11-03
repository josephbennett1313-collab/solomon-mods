// Draws Session Keeper's panel on the terminal and the desktop, and presses its buttons.
// Run: claude plugin test mods/session-keeper
import { expect, test } from 'claude-code/testing'

const band = <S extends 'terminal' | 'desktop'>(surface: S) =>
  ({
    plugin: 'session-keeper',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 60, bodyColumns: 120, scroll: { offset: 0, bodyRows: 60 }, view: {} },
  }) as const

const now = Date.now()
// A big chat whose cache went cold three hours ago, with Auto Model on Opus.
const SEED: Record<string, unknown> = {
  'session-keeper/bar': { now, lastEnd: now - 3 * 60 * 60_000, ttlMs: 5 * 60_000, ttlKnown: true, tokens: 180_000, percent: 41, sessionUsd: 3.2, fiveHour: 12, week: 73, model: 'claude-opus-5-5', fast: false },
  'session-keeper/suggest': { main: { command: 'compact', label: '/compact', why: 'Compact now.' }, others: [{ command: 'context', label: '/context', why: 'See what is loaded.' }] },
  'session-keeper/facts': { startedAt: now - 42 * 60_000, tools: 118, edits: 23, compactions: 1, branch: 'main' },
  'auto-model/pick': { model: 'claude-opus-5-5', effort: 'xhigh', fast: false, ultracode: false, tier: 'expert', why: 'a hard, high-stakes job', compacted: false, at: now },
  'auto-model/live': { installed: true, fast: false, ultracode: false, model: 'claude-opus-5-5', switching: '' },
}

type Hooks = Parameters<Parameters<typeof test>[1]>[1]

function engine(on: Hooks, ran: string[]) {
  on('state.get', async (_$, e, next) => {
    const k = `${e.plugin}/${e.key}`
    return k in SEED ? { value: { value: SEED[k], version: 1 } } : next(e)
  })
  // The engine's own band under the plugins: nothing of its own here.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('command.run', (_$, e) => {
    ran.push(`${e.command} ${e.args}`.trim())
    return { text: `ran /${e.command} ${e.args}` }
  })
}

test('the panel draws on the terminal and the desktop, with Auto Model inside it', async ($, on) => {
  engine(on, [])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface))
    for (const words of [/Session Keeper/, /Cache cold for 2h 5\dm/, /118 tool calls/, /Auto Model/, /Opus 5\.5/, /week/]) {
      const found = await ui.find({ type: 'Text', text: words })
      expect(found).toBeDefined()
    }
    expect(await ui.find({ key: 'sk-handoff' })).toBeDefined()
    expect(await ui.find({ key: 'sk-warm' })).toBeDefined()
    const fast = await ui.find({ key: 'sk-am-fast' })
    expect(String(fast?.props.label)).toBe('⚡ fast mode · auto')
    const ultra = await ui.find({ key: 'sk-am-ultra' })
    expect(String(ultra?.props.label)).toBe('🛠 Ultracode · auto')
    // Every button has its own key, so a press never reaches the wrong one.
    const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
    expect(new Set(keys).size).toBe(keys.length)
    await ui.unmount()
  }
})

test('the desktop crab stands in the snow when the cache has been cold for hours', async ($, on) => {
  engine(on, [])
  const ui = await $.ui.mount(band('desktop'))
  const crab = await ui.find({ type: 'Svg' })
  expect(String(crab?.props.alt)).toMatch(/snow/)
  await ui.unmount()
})

test('the fast mode and Ultracode buttons run the real commands', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'sk-am-fast' })
  expect(ran).toContain('fast on')
  await ui.press({ key: 'sk-am-ultra' })
  expect(ran).toContain('effort ultracode on')
  await ui.unmount()
})

test('Hand off to a fresh chat opens the device picker inside the panel', async ($, on) => {
  engine(on, [])
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'sk-handoff' })
  expect(await ui.find({ key: 'sk-ho-macmini' })).toBeDefined()
  expect(await ui.find({ key: 'sk-ho-iphone' })).toBeDefined()
  await ui.unmount()
})

test('the smart button runs its command', async ($, on) => {
  const ran: string[] = []
  engine(on, ran)
  const ui = await $.ui.mount(band('terminal'))
  await ui.press({ key: 'sk-smart' })
  expect(ran).toContain('compact')
  await ui.unmount()
})

test('the hold, the guide, a note and a ready handoff all draw inside the panel', async ($, on) => {
  SEED['session-keeper/hold'] = { text: 'Fix the login page', nowUsd: 0.9, warmUsd: 0.04, coldMins: 175, tokens: 180_000 }
  SEED['session-keeper/expanded'] = true
  SEED['session-keeper/note'] = 'Fast mode on for this chat.'
  SEED['session-keeper/handoff'] = { phase: 'ready', device: 'Mac mini', file: '/tmp/h.md', text: '# Handoff', note: 'Ready.' }
  try {
    engine(on, [])
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount(band(surface))
      expect(await ui.find({ key: 'sk-hold-pay' })).toBeDefined()
      expect(await ui.find({ key: 'sk-ho-start' })).toBeDefined()
      expect(await ui.find({ key: 'sk-g-close' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Fast mode on for this chat/ })).toBeDefined()
      const keys = (await ui.findAll({ type: 'Button' })).map(b => b.key)
      expect(new Set(keys).size).toBe(keys.length)
      await ui.unmount()
    }
  } finally {
    for (const k of ['hold', 'expanded', 'note', 'handoff']) delete SEED[`session-keeper/${k}`]
  }
})

test('the slim row draws on one line with the model and a + to open', async ($, on) => {
  SEED['session-keeper/min'] = true
  try {
    engine(on, [])
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount(band(surface))
      expect(await ui.find({ key: 'sk-expand' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Opus 5\.5/ })).toBeDefined()
      await ui.unmount()
    }
  } finally {
    delete SEED['session-keeper/min']
  }
})
