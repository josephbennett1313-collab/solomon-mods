// Design Picker (Solomon Mods; the idea is AI Labs'): see each design style before you choose.
// - The styles come from your installed UI UX Pro Max skill (its data/styles.csv), read when needed.
//   Nothing from that list is copied into this mod; a short built-in list covers a missing file.
// - /styles <what you're building> ranks the styles for it and opens a pane of preview cards:
//   a small drawn mock-up on desktop, colour swatches in the terminal.
// - Claude can open the same pane with the pick_design_style tool, and it opens by itself when you
//   ask to build a page, site, app or screen without naming a style. The pick goes back to Claude
//   as your next message, with the style's keywords, colours, effects, your motion choice (none,
//   subtle or 3D) and the design skills you have installed.
// - Mock-up first asks Claude for a real HTML mock-up as an Artifact before anything is built.
// - Send to Figma has Claude build that mock-up and push it into your Figma file with the connector's
//   html_to_figma tool (set {"figmaFile": "<link>"} in ~/.claude/mods/settings.json to skip the question).

import type { EngineInterface, Register } from 'claude-code'

import type { Motion, View } from '../types'
import { FALLBACK, type Style, briefOf, mockupPrompt, previewSvg, rank, stylesFromCsv, tokensOf, withMotion } from './styles'
import { ACCENT, MARK, cut, homeOf, isOn, isPartOn, log as suiteLog, oneLine, readJson, readSwitches, roomy } from './suite'

const NAME = 'design-picker'
const PANE = 'design-picker'
const TITLE = 'Design Picker'
const TOOL = 'pick_design_style'
const PER_PAGE = 4
const VIEW = { plugin: 'design-picker', key: 'view' } as const
const EMPTY: View = { query: '', ids: [], page: 0, picked: '' }
const parts = { on: true, tool: true, auto: true, figma: true }
// Design skills the brief tells Claude to use, when they are installed.
const DESIGN_SKILLS = ['ui-ux-pro-max', 'taste-skill', 'impeccable', 'emil-design-eng', 'animate', '21st-ui', 'improve-animations']
let skillsFound: string[] = []
let autoOpened = false
const BUILD_RE = /\b(build|make|create|design|redesign|mock ?up|prototype)\b[^.?!]{0,60}\b(website|site|landing page|page|app|dashboard|screen|ui|interface|homepage|portfolio|storefront)\b/i
const NAMED_RE = /\b(minimal\w*|glass\w*|brutalis\w*|neumorph\w*|clay\w*|bento|retro|skeuomorph\w*|flat design|material design|style:)\b/i
let stylesFile = ''

const log = ($: EngineInterface, line: string) => suiteLog($, NAME, line)

let cache: { path: string; styles: Style[] } | null = null

async function loadStyles($: EngineInterface): Promise<Style[]> {
  const path = (stylesFile || '~/.claude/skills/ui-ux-pro-max/data/styles.csv').replace(/^~(?=\/)/, homeOf($))
  if (cache?.path === path) return cache.styles
  let styles = FALLBACK
  try {
    if (await $.fs.exists(path)) {
      const read = stylesFromCsv(String(await $.fs.read(path)))
      if (read.length) styles = read
    }
  } catch (err) {
    await log($, `read styles: ${String(err)}`)
  }
  cache = { path, styles }
  return styles
}

async function getView($: EngineInterface): Promise<View> {
  const { value } = await $.state.get(VIEW)
  return value ?? EMPTY
}

async function openPicker($: EngineInterface, query: string) {
  const styles = rank(await loadStyles($), query)
  const old = await getView($)
  await $.state.set(VIEW, { query, ids: styles.map(s => s.id), page: 0, picked: '', motion: old.motion ?? 'subtle' })
  await $.ui.open({ id: PANE, title: TITLE }).catch(err => log($, `open: ${String(err)}`))
  return styles
}

async function pick($: EngineInterface, n: number) {
  const view = await getView($)
  const styles = await loadStyles($)
  const s = styles.find(x => x.id === view.ids[n])
  if (!s) return
  await $.state.set(VIEW, { ...view, picked: s.id })
  try {
    $.ui.toast(`${MARK[NAME]} Sent "${s.name}" to Claude`)
  } catch {
    // Only a hint.
  }
  $.clock.after(1, () => void $.prompt.submit({ text: briefOf(s, view.query, view.motion ?? 'subtle', skillsFound), asUser: true }))
}

async function mockup($: EngineInterface, n: number) {
  const view = await getView($)
  const s = (await loadStyles($)).find(x => x.id === view.ids[n])
  if (!s) return
  await $.state.set(VIEW, { ...view, picked: s.id })
  $.clock.after(1, () => void $.prompt.submit({ text: mockupPrompt(s, view.query, view.motion ?? 'subtle', skillsFound), asUser: true }))
}

/** Send to Figma: Claude makes the HTML mock-up, then puts it in your Figma file with the connector's html_to_figma tool. */
async function toFigma($: EngineInterface, n: number) {
  const view = await getView($)
  const s = (await loadStyles($)).find(x => x.id === view.ids[n])
  if (!s) return
  const file = (await readJson<{ figmaFile?: string }>($, 'settings.json', {})).figmaFile ?? ''
  const text = [
    `Put the "${s.name}" style${view.query ? ` for: ${oneLine(view.query)}` : ''} into Figma, using my Figma connector.`,
    '1. Build the mock-up as one self-contained HTML document (all CSS in a <style> block, images inline as SVG or data URIs, no external resources). Use the direction below.',
    `2. Call the Figma connector's html_to_figma tool${file ? ` on my file ${file}` : ''} and POST that HTML to the URL it returns. It makes a new page of layers in the file.${file ? '' : ' If you do not know which Figma file to use, ask me for the file link first and do nothing else.'}`,
    '3. Reply with the Figma link to the new page.',
    'If the Figma connector is not connected, say so and tell me to connect it under /mcp. Do not make anything else instead.',
    '',
    briefOf(s, view.query, view.motion ?? 'subtle', skillsFound),
  ].join('\n')
  $.clock.after(1, () => void $.prompt.submit({ text, asUser: true }))
}

async function findSkills($: EngineInterface) {
  const home = homeOf($)
  const found: string[] = []
  for (const name of DESIGN_SKILLS) {
    if (await $.fs.exists(`${home}/.claude/skills/${name}/SKILL.md`).catch(() => false)) found.push(name)
  }
  skillsFound = found
}

async function readSwitch($: EngineInterface) {
  try {
    const json = await readSwitches($)
    parts.on = isOn(json, NAME)
    parts.tool = isPartOn(json, NAME, 'tool')
    parts.auto = isPartOn(json, NAME, 'auto')
    parts.figma = isPartOn(json, NAME, 'figma')
  } catch {
    // A broken file changes nothing.
  }
}

// ---------- Hooks ----------

export const register: Register = (on, options) => {
  const o = options as Record<string, unknown>
  if (typeof o.stylesFile === 'string') stylesFile = o.stylesFile.trim()

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    cache = null
    autoOpened = false
    await readSwitch($)
    void findSkills($)
    $.clock.every(3000, () => {
      void readSwitch($)
    })
    await $.tool.register({
      name: TOOL,
      description:
        'Open the Design Picker so the user can SEE design styles (minimal, glass, brutalist, clay and more) as previews and choose one. ' +
        'Call it before building a new interface when the user has not named a style. The user picks in the pane; their pick arrives as their next message, so stop and wait after calling it.',
      inputSchema: {
        type: 'object',
        properties: { description: { type: 'string', description: 'What is being built, in a few words, used to rank the styles.' } },
        required: ['description'],
      },
      isDeferred: false,
    }).catch(err => log($, `register tool: ${String(err)}`))
    // /design is Claude Code's own command, so this one is /styles.
    await $.command
      .register({ name: 'styles', description: 'Design Picker: see design styles as previews and pick one. Add what you are building to rank them, e.g. /styles booking site for a spa', argumentHint: '[what you are building]', immediate: true })
      .catch(err => log($, `register command: ${String(err)}`))
    return r
  })

  on('command.run', { command: 'styles' }, async ($, e) => {
    if (!parts.on) return { text: `${MARK[NAME]} Design Picker is off. Turn it on in /mods.` }
    const styles = await openPicker($, e.args.trim())
    const top = styles.slice(0, 3).map(s => s.name).join(', ')
    return { text: `${MARK[NAME]} Design Picker open with ${styles.length} styles${e.args.trim() ? `. Best fits: ${top}` : ''}. Pick one in the pane.` }
  })

  // Opens by itself once per chat when you ask to build an interface without naming a style.
  on('prompt.submit', async ($, e, next) => {
    const person = e.origin.kind === 'composer' || e.origin.kind === 'bridge' || e.origin.kind === 'sdk'
    if (person && !e.command && !e.isMeta && parts.on && parts.auto && !autoOpened && BUILD_RE.test(e.text) && !NAMED_RE.test(e.text)) {
      autoOpened = true
      void openPicker($, e.text.slice(0, 200)).catch(err => log($, `auto open: ${String(err)}`))
      try {
        $.ui.toast(`${MARK[NAME]} Design Picker opened: pick a style while Claude plans`)
      } catch {
        // Only a hint.
      }
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!String(e.tool).endsWith(`__${TOOL}`) && String(e.tool) !== TOOL) return next(e)
    if (!parts.on || !parts.tool) return { result: 'Design Picker is turned off. Ask the user which style they want in plain words.', isError: true } as never
    const query = String((e as unknown as Record<string, unknown>).description ?? '').trim()
    const styles = await openPicker($, query)
    const top = styles
      .slice(0, PER_PAGE)
      .map(s => `${s.name} (${cut(oneLine(s.bestFor), 60)})`)
      .join('; ')
    return { result: `The Design Picker is open beside the chat with ${styles.length} styles; the best fits shown first: ${top}. The user's pick will arrive as their next message. Stop here and wait for it.` } as never
  })

  on('ui.press', { plugin: 'design-picker' }, async ($, e) => {
    const view = await getView($)
    const pages = Math.max(1, Math.ceil(view.ids.length / PER_PAGE))
    if (e.element === 'next') await $.state.set(VIEW, { ...view, page: Math.min(pages - 1, view.page + 1) })
    else if (e.element === 'prev') await $.state.set(VIEW, { ...view, page: Math.max(0, view.page - 1) })
    else if (e.element === 'close') await $.ui.close({ id: PANE }).catch(() => undefined)
    else if (/^pick-\d+$/.test(e.element)) await pick($, Number(e.element.slice(5)))
    else if (/^figma-\d+$/.test(e.element)) await toFigma($, Number(e.element.slice(6)))
    else if (/^mock-\d+$/.test(e.element)) await mockup($, Number(e.element.slice(5)))
    else if (/^motion-(none|subtle|3d)$/.test(e.element)) await $.state.set(VIEW, { ...view, motion: e.element.slice(7) as Motion })
    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => roomy(await (async () => {
    if (!parts.on) return next(e)
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : null
    const width = Math.max(36, e.props.bodyColumns)
    const view = await getView($)
    const all = await loadStyles($)
    const byId = new Map(all.map(s => [s.id, s]))
    const ids = view.ids.length ? view.ids : all.map(s => s.id)
    const pages = Math.max(1, Math.ceil(ids.length / PER_PAGE))
    const page = Math.min(view.page, pages - 1)
    const shown = ids.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)
    const textW = Svg ? Math.max(20, width - 26) : width - 2
    const noop = () => undefined
    const fromSkill = all !== FALLBACK
    return (
      <Box flexDirection="column" width={width} gap="sm">
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text bold color={ACCENT}>{`${MARK[NAME]} `}</Text>
            <Text bold>Design Picker</Text>
          </Text>
          <Button key="close" label="Close" dimColor onPress={noop} />
        </Box>
        <Text dimColor wrap="truncate-end">
          {view.query ? `Ranked for: ${cut(oneLine(view.query), width - 14)}` : `${ids.length} styles${fromSkill ? ' from UI UX Pro Max' : ' (built-in list: UI UX Pro Max not found)'}`}
        </Text>
        <Box key="motion" flexDirection="row" gap={1}>
          <Text dimColor>Motion:</Text>
          {(['none', 'subtle', '3d'] as const).map(m => (
            <Button key={`motion-${m}`} plain onPress={noop}>
              <Text bold={(view.motion ?? 'subtle') === m} color={(view.motion ?? 'subtle') === m ? ACCENT : undefined} dimColor={(view.motion ?? 'subtle') !== m}>
                {m === 'none' ? 'None' : m === 'subtle' ? 'Subtle' : '3D'}
              </Text>
            </Button>
          ))}
        </Box>
        {shown.map((sid, k) => {
          const s = byId.get(sid)
          if (!s) return null
          const n = page * PER_PAGE + k
          const t = tokensOf(s)
          const picked = view.picked === s.id
          return (
            <Box key={`card-${sid}`} flexDirection="row" gap="sm" borderStyle="round" borderColor={picked ? ACCENT : undefined} paddingX={1} paddingY={0}>
              {Svg ? <Svg key={`svg-${sid}`} source={withMotion(previewSvg(s), view.motion ?? 'subtle')} alt={`${s.name} preview`} width={168} height={104} /> : null}
              <Box flexDirection="column" width={textW} gap="xs">
                <Text bold color={picked ? ACCENT : undefined}>{`${n + 1}. ${s.name}${picked ? '  ✓ sent' : ''}`}</Text>
                {!Svg ? (
                  <Text>
                    {t.swatches.map((hex, i) => (
                      <Text key={`sw-${sid}-${i}`} color={hex}>
                        ██{' '}
                      </Text>
                    ))}
                  </Text>
                ) : null}
                <Text dimColor wrap="wrap">{`Best for: ${cut(oneLine(s.bestFor), textW * 2)}`}</Text>
                {s.avoid ? <Text dimColor wrap="truncate-end">{`Avoid for: ${cut(oneLine(s.avoid), textW)}`}</Text> : null}
                <Box flexDirection="row" gap={1}>
                  <Button key={`pick-${n}`} label={picked ? 'Build again' : 'Build with this'} variant={picked ? 'secondary' : 'primary'} onPress={noop} />
                  <Button key={`mock-${n}`} label="Mock-up first" onPress={noop} />
                  {parts.figma ? <Button key={`figma-${n}`} label="Send to Figma" plain onPress={noop} /> : null}
                </Box>
              </Box>
            </Box>
          )
        })}
        {skillsFound.length ? <Text dimColor wrap="wrap">{`Claude will build it with: ${skillsFound.join(', ')}`}</Text> : null}
        <Box flexDirection="row" justifyContent="space-between">
          <Button key="prev" label="◀ Prev" hotkey="p" dimColor={page === 0} onPress={noop} />
          <Text dimColor>{`Page ${page + 1} of ${pages}`}</Text>
          <Button key="next" label="Next ▶" hotkey="n" dimColor={page >= pages - 1} onPress={noop} />
        </Box>
      </Box>
    )
  })(), e.surface))
}
