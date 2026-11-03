// Auto Model's own chip: hidden while Session Keeper's panel shows Auto Model, drawn otherwise.
// Run: claude plugin test mods/auto-model
import { expect, test } from 'claude-code/testing'

const band = <S extends 'terminal' | 'desktop'>(surface: S) =>
  ({
    plugin: 'auto-model',
    surface,
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 40, bodyColumns: 120, scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const

type Hooks = Parameters<Parameters<typeof test>[1]>[1]

function engine(on: Hooks, seed: Record<string, unknown>, ran: string[]) {
  on('state.get', async (_$, e, next) => {
    const k = `${e.plugin}/${e.key}`
    return k in seed ? { value: { value: seed[k], version: 1 } } : next(e)
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('fs.exists', () => ({ value: false }))
  on('command.run', (_$, e) => {
    ran.push(`${e.command} ${e.args}`.trim())
    return { text: `ran /${e.command} ${e.args}` }
  })
}

test('no chip while Session Keeper shows Auto Model in its panel', async ($, on) => {
  engine(on, { 'session-keeper/hosting': true }, [])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface))
    expect(await ui.find({ key: 'am-fast' })).toBeUndefined()
    await ui.unmount()
  }
})

test('the chip draws when the panel is hidden, and its buttons run the real commands', async ($, on) => {
  const ran: string[] = []
  engine(on, { 'session-keeper/hosting': false }, ran)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface))
    expect(String((await ui.find({ key: 'am-fast' }))?.props.label)).toBe('⚡ fast mode · auto')
    expect(String((await ui.find({ key: 'am-ultra' }))?.props.label)).toBe('🛠 Ultracode · auto')
    await ui.unmount()
  }
  const ui = await $.ui.mount(band('desktop'))
  await ui.press({ key: 'am-fast' })
  expect(ran).toContain('fast on')
  await ui.unmount()
})
