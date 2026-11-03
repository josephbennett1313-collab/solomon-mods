// Mod Switchboard (Solomon Mods): /mods turns any suite mod, or one part of it, on or off in
// every chat. Built on Ben AI's "mods" pane: the same ~/.claude/mods/switches.json, so his
// mods keep working with it. Each suite mod describes itself and its parts in suite.json.

import type { EngineInterface, Register } from 'claude-code'

import type { Row } from '../types'
import {
  GRADIENT,
  MARK,
  STATUS,
  cut,
  homeOf,
  takeOpenRequest,
  isHidden,
  isOn,
  isPartOn,
  log,
  readSwitches,
  writeSwitches,
  roomy,
} from './suite'

const NAME = 'mod-switchboard'
const PANE = 'mod-switchboard'
const TITLE = 'Mods'
const NOTE = { plugin: 'mod-switchboard', key: 'note' } as const
const OPEN = { plugin: 'mod-switchboard', key: 'collapsed' } as const
const SCAN_MS = 10_000
const POLL_MS = 3000

// The originals a suite mod takes the place of, so the pane can say so.
let sid = ''
let lastRaw = ''
let cache: { at: number; rows: Row[] } | null = null

async function readText($: EngineInterface, path: string) {
  try {
    if (!(await $.fs.exists(path))) return ''
    return String(await $.fs.read(path))
  } catch {
    return ''
  }
}

function parse(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function listDirs($: EngineInterface, dir: string) {
  try {
    const entries = await $.fs.list(dir)
    return entries.filter(x => !x.name.startsWith('.') && (x.kind === 'dir' || x.isLink)).map(x => `${dir}/${x.name}`)
  } catch {
    return []
  }
}

/** Installed plugins: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>, newest last. */
async function cacheDirs($: EngineInterface, home: string) {
  const out: string[] = []
  for (const market of await listDirs($, `${home}/.claude/plugins/cache`)) {
    for (const plugin of await listDirs($, market)) {
      const versions = (await listDirs($, plugin)).sort()
      const last = versions[versions.length - 1]
      if (last) out.push(last)
    }
  }
  return out
}

/** CLAUDE_CODE_PLUGIN_DIRS folders, '~' as home. */
async function envDirs($: EngineInterface) {
  let raw: string | undefined
  try {
    raw = await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')
  } catch {
    return []
  }
  if (!raw) return []
  const home = homeOf($)
  return raw
    .split(':')
    .map(x => x.trim())
    .filter(Boolean)
    .map(x => (x === '~' ? home : x.startsWith('~/') ? `${home}${x.slice(1)}` : x).replace(/\/+$/, ''))
}

const titleCase = (name: string) =>
  name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')

async function hooksSource($: EngineInterface, dir: string) {
  let text = ''
  try {
    for (const x of await $.fs.list(`${dir}/hooks`)) {
      if (x.kind !== 'file' || !/\.(tsx?|jsx?|mjs|cjs)$/.test(x.name) || /\.test\./.test(x.name) || x.size > 2_000_000) continue
      text += `${await readText($, `${dir}/hooks/${x.name}`)}\n`
    }
  } catch {
    // Nothing found in an unreadable folder.
  }
  return text
}

/** One folder: a suite mod (suite.json), another mod (hooks module), or nothing. */
async function inspect($: EngineInterface, dir: string, chatOnly: boolean): Promise<Row | null> {
  const plugin = parse(await readText($, `${dir}/.claude-plugin/plugin.json`))
  if (!Object.keys(plugin).length) return null
  if (!('modules' in parse(await readText($, `${dir}/hooks/hooks.json`)))) return null
  const name = typeof plugin.name === 'string' && plugin.name ? plugin.name : (dir.split('/').pop() ?? '')
  if (!name || name === NAME) return null
  const suite = parse(await readText($, `${dir}/suite.json`))
  const isSuite = Object.keys(suite).length > 0
  const source = isSuite ? '' : await hooksSource($, dir)
  const parts = Array.isArray(suite.parts)
    ? (suite.parts as Record<string, unknown>[])
        .filter(p => typeof p.key === 'string' && typeof p.label === 'string')
        .map(p => ({ key: String(p.key), label: String(p.label), byDefault: p.default !== false }))
    : []
  const commands = [...source.matchAll(/command\.register\(\s*\{\s*name:\s*['"`]([^'"`]+)['"`]/g)].map(m => `/${m[1]}`)
  return {
    name,
    title: typeof suite.title === 'string' ? suite.title : titleCase(name),
    what: typeof suite.what === 'string' ? suite.what : typeof plugin.description === 'string' ? plugin.description : '',
    tip: typeof suite.command === 'string' ? suite.command : [...new Set(commands)].join(', '),
    pane: suite.pane === true,
    hide: suite.hide === true,
    suite: isSuite,
    switchable: isSuite || source.includes('switches.json'),
    chatOnly,
    parts,
    replaces: Array.isArray(suite.replaces) ? (suite.replaces as unknown[]).map(String) : [],
  }
}

async function scan($: EngineInterface): Promise<Row[]> {
  const home = homeOf($)
  const found = new Map<string, Row>()
  const dirs: [string, boolean][] = []
  for (const d of await listDirs($, `${home}/.claude/mods`)) dirs.push([d, false])
  for (const d of await envDirs($)) dirs.push([d, false])
  for (const d of await cacheDirs($, home)) dirs.push([d, false])
  if (sid) for (const d of await listDirs($, `${home}/.claude/dev-mods/${sid}`)) dirs.push([d, true])
  const seen = new Set<string>()
  for (const [dir, chatOnly] of dirs) {
    if (seen.has(dir)) continue
    seen.add(dir)
    const row = await inspect($, dir, chatOnly).catch(() => null)
    // A mod loaded for this chat only wins over an installed copy of the same name.
    if (row && (!found.has(row.name) || chatOnly)) found.set(row.name, row)
  }
  const all = [...found.values()]
  const suite = all.filter(r => r.suite).sort((a, b) => a.title.localeCompare(b.title))
  const rest = all.filter(r => !r.suite).sort((a, b) => a.title.localeCompare(b.title))
  return [...suite, ...rest]
}

async function getRows($: EngineInterface, force = false) {
  const now = await $.clock.now()
  if (!force && cache && now - cache.at < SCAN_MS) return cache.rows
  const rows = await scan($)
  cache = { at: now, rows }
  return rows
}

async function note($: EngineInterface, text: string) {
  await $.state.set(NOTE, text)
}

async function rowNamed($: EngineInterface, name: string) {
  return (await getRows($)).find(r => r.name === name)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      sid = await $.session.id()
      cache = null
      await $.command.register({ name: 'mods', description: 'Mod Switchboard: turn each mod, or one part of it, on or off in every chat', immediate: true })
      lastRaw = JSON.stringify(await readSwitches($, true))
      $.clock.every(POLL_MS, () => {
        void (async () => {
          // Mission Control's Mods button asks for the pane through a file.
          if (await takeOpenRequest($, NAME, sid)) {
            await getRows($).catch(() => undefined)
            await $.ui.open({ id: PANE, title: TITLE })
          }
          const raw = JSON.stringify(await readSwitches($, true))
          if (raw === lastRaw) return
          lastRaw = raw
          $.ui.invalidate('ui.render')
        })().catch(err => log($, NAME, `poll: ${String(err)}`))
      })
      $.clock.every(SCAN_MS, () => {
        void (async () => {
          const open = (await $.ui.panes()).some(p => p.id === PANE)
          if (!open) return
          const before = JSON.stringify(cache?.rows ?? [])
          if (JSON.stringify(await getRows($, true)) !== before) $.ui.invalidate('ui.render')
        })().catch(err => log($, NAME, `scan: ${String(err)}`))
      })
    } catch (err) {
      await log($, NAME, `start: ${String(err)}`)
    }
    return next(e)
  })

  on('command.run', { command: 'mods' }, async $ => {
    await getRows($).catch(err => log($, NAME, `scan: ${String(err)}`))
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Opened Mod Switchboard.' }
  })

  on('ui.press', { plugin: 'mod-switchboard' }, async ($, e, next) => {
    const key = e.element
    const [verb, rest = ''] = [key.slice(0, key.indexOf('-')), key.slice(key.indexOf('-') + 1)]
    try {
      if (verb === 'expand') {
        const { value: open = [] } = await $.state.get(OPEN)
        await $.state.set(OPEN, open.includes(rest) ? open.filter(x => x !== rest) : [...open, rest])
        return { element: key }
      }
      if (verb === 'refresh') {
        await getRows($, true)
        await note($, 'Looked for mods again.')
        return { element: key }
      }
      if (verb === 'toggle' || verb === 'show' || verb === 'open') {
        const mod = await rowNamed($, rest)
        if (!mod || !mod.switchable) return { element: key }
        const json = { ...(await readSwitches($, true)) }
        if (verb === 'toggle') {
          const turnOff = isOn(json, rest)
          if (turnOff) json[rest] = false
          else delete json[rest]
          await writeSwitches($, json)
          await note($, `${mod.title} is ${turnOff ? 'off' : 'on'} in every chat.`)
        } else if (verb === 'show') {
          if (!isOn(json, rest)) return (await note($, `${mod.title} is off. Turn it on first.`), { element: key })
          const hide = !isHidden(json, rest)
          if (hide) json[`${rest}:hidden`] = true
          else delete json[`${rest}:hidden`]
          await writeSwitches($, json)
          if (!hide && mod.pane && sid) await $.fs.write(`${homeOf($)}/.claude/mods/.open-${rest}-${sid}`, '')
          await note($, `${mod.title} is ${hide ? 'hidden' : 'shown'} in every chat.`)
        } else {
          if (!isOn(json, rest) || isHidden(json, rest)) return (await note($, `Turn ${mod.title} on and show it first.`), { element: key })
          await $.fs.write(`${homeOf($)}/.claude/mods/.open-${rest}-${sid}`, '')
          await note($, `${mod.title} opens in this chat within 3 seconds.`)
        }
        return { element: key }
      }
      if (verb === 'part') {
        const [mod, part] = rest.split('~')
        const row = mod ? await rowNamed($, mod) : undefined
        const p = row?.parts.find(x => x.key === part)
        if (!row || !p) return { element: key }
        const json = { ...(await readSwitches($, true)) }
        const k = `${row.name}:${p.key}`
        const nowOn = !isPartOn(json, row.name, p.key, p.byDefault)
        // Store only what differs from the part's default, so the file stays short.
        if (nowOn === p.byDefault) delete json[k]
        else json[k] = nowOn
        await writeSwitches($, json)
        await note($, `${row.title}: ${p.label} ${nowOn ? 'on' : 'off'}.`)
        return { element: key }
      }
    } catch (err) {
      await log($, NAME, `press ${key}: ${String(err)}`)
      await note($, 'That did not save. See ~/.claude/mods-logs/mod-switchboard.log')
      return { element: key }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => roomy(await (async () => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const noop = () => undefined
    const cols = Math.max(30, e.props.bodyColumns)
    const msg = (await $.state.get(NOTE)).value ?? ''
    const { value: collapsed = [] } = await $.state.get(OPEN)
    const json = await readSwitches($)
    let rows: Row[] = []
    try {
      rows = await getRows($)
    } catch (err) {
      await log($, NAME, `draw scan: ${String(err)}`)
    }
    const suite = rows.filter(r => r.suite)
    const other = rows.filter(r => !r.suite)
    const onCount = suite.filter(r => isOn(json, r.name)).length
    const partsOff = suite.reduce((n, r) => n + r.parts.filter(p => !isPartOn(json, r.name, p.key, p.byDefault)).length, 0)
    const names = new Set(rows.map(r => r.name))

    // The switch: a green pill when on, a hollow dim one when off.
    const pill = (key: string, isActive: boolean, dim = false) => (
      <Button key={key} plain onPress={noop}>
        {isActive && !dim ? <Text bold color={STATUS.good}>{'● ON '}</Text> : <Text dimColor>{'○ OFF'}</Text>}
      </Button>
    )

    const row = (m: Row) => {
      const off = m.switchable && !isOn(json, m.name)
      const hidden = isHidden(json, m.name)
      const showParts = !collapsed.includes(m.name) && !off
      const dupes = m.replaces.filter(n => names.has(n))
      const offParts = m.parts.filter(p => !isPartOn(json, m.name, p.key, p.byDefault)).length
      return (
        <Box key={`row-${m.name}`} flexDirection="column" width={cols} borderStyle="round" borderDimColor={off} borderColor={off ? undefined : GRADIENT[1]} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" width={cols - 4}>
            <Box flexDirection="row" columnGap={1} flexShrink={1}>
              <Text color={off ? undefined : GRADIENT[1]} dimColor={off}>{MARK[m.name] ?? '•'}</Text>
              <Text bold dimColor={off} wrap="truncate-end">{m.title}</Text>
              {m.tip ? <Text dimColor wrap="truncate-end">{cut(m.tip, Math.max(8, cols - 44))}</Text> : null}
            </Box>
            <Box flexDirection="row" columnGap={1} flexShrink={0}>
              {m.pane && !off && !hidden ? <Button key={`open-${m.name}`} plain label="Open" onPress={noop} /> : null}
              {m.hide && !off ? <Button key={`show-${m.name}`} plain dimColor label={hidden ? 'Hidden' : 'Shown'} onPress={noop} /> : null}
              {m.switchable ? pill(`toggle-${m.name}`, !off) : <Text dimColor>via /plugin</Text>}
            </Box>
          </Box>
          {m.what && !off ? <Text dimColor wrap="wrap">{m.what}</Text> : null}
          {m.chatOnly ? <Text color={STATUS.info}>Loaded in this chat only (testing)</Text> : null}
          {dupes.length ? <Text color={STATUS.warn}>{`Replaces ${dupes.join(', ')}, still installed: both run until you remove the old one.`}</Text> : null}
          {m.parts.length && !off ? (
            <Button key={`expand-${m.name}`} plain dimColor onPress={noop}>
              {showParts ? '▾ Parts' : `▸ ${m.parts.length} parts${offParts ? ` · ${offParts} off` : ''}`}
            </Button>
          ) : null}
          {showParts
            ? m.parts.map(p => {
                const pOn = isPartOn(json, m.name, p.key, p.byDefault)
                return (
                  <Box key={`p-${m.name}-${p.key}`} flexDirection="row" justifyContent="space-between" alignItems="center" width={cols - 4}>
                    <Box flexDirection="row" columnGap={1} flexShrink={1}>
                      <Text dimColor>{'  ·'}</Text>
                      <Text dimColor={!pOn} wrap="truncate-end">{p.label}</Text>
                    </Box>
                    <Box flexShrink={0}>{pill(`part-${m.name}~${p.key}`, pOn)}</Box>
                  </Box>
                )
              })
            : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={cols} gap="xs">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" width={cols}>
          <Box flexDirection="column">
            <Text color={GRADIENT[1]} bold size="caption">SOLOMON MODS</Text>
            <Text bold size="heading">Mods</Text>
          </Box>
          <Box flexDirection="row" columnGap={1} alignItems="center">
            <Text dimColor>{`${onCount} of ${suite.length} on${partsOff ? ` · ${partsOff} parts off` : ''}`}</Text>
            <Button key="refresh-all" plain dimColor label="Refresh" onPress={noop} />
          </Box>
        </Box>
        {msg ? <Text color={STATUS.good}>{cut(msg, cols)}</Text> : null}
        {suite.length ? null : <Text dimColor>No Solomon mods found yet.</Text>}
        {suite.map(row)}
        {other.length ? (
          <Box marginTop={1}>
            <Text bold dimColor>{`Other mods · ${other.length}`}</Text>
          </Box>
        ) : null}
        {other.map(row)}
        <Text dimColor size="caption" wrap="wrap">
          A switch changes every open chat within 3 seconds. Off stops the mod everywhere; Hidden keeps it working out of sight; each part is one feature of a mod.
        </Text>
      </Box>
    )
  })(), e.surface))
}
