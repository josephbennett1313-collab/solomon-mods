// Higgs Content (Solomon Mods): a clean photo and video studio on the Higgsfield connector.
// 1. Describe it (or /create <idea>). 2. Claude upgrades the prompt into a proper shot brief.
// 3. You see the exact credit cost and your balance, and nothing is spent until you press Create.
// 4. Results land in the gallery with links to open them.
// Needs the Higgsfield connector. If it has another name, set {"higgsfield": "<name>"} in
// ~/.claude/mods/settings.json. Written for Solomon Mods.

import type { EngineInterface, McpToolResult, Register, RenderChildren } from 'claude-code'

import type { Draft, Kind, Shot } from '../types'
import { ACCENT, STATUS, cut, log, paletteAt, partOn, readJson, roomy } from './suite'

const NAME = 'higgs-content'
const PANE = 'higgs-content'
const DRAFT = { plugin: 'higgs-content', key: 'draft' } as const
const GALLERY = { plugin: 'higgs-content', key: 'gallery' } as const
const BALANCE = { plugin: 'higgs-content', key: 'balance' } as const
const SERVER = { plugin: 'higgs-content', key: 'server' } as const
const NAMES = ['claude.ai Higgsfield', 'Higgsfield', 'higgsfield', 'claude.ai Higgsfield AI']
const MODELS: Record<Kind, { id: string; label: string }[]> = {
  photo: [
    { id: 'gpt_image_2_5', label: 'All-round' },
    { id: 'soul_2', label: 'Portrait & fashion' },
    { id: 'marketing_studio_image', label: 'Product & ads' },
  ],
  video: [
    { id: 'seedance_2_5', label: 'All-round' },
    { id: 'kling3_0', label: 'Multi-shot & audio' },
    { id: 'marketing_studio_video', label: 'Product & ads' },
  ],
}
const ASPECTS = ['1:1', '4:5', '9:16', '16:9']
const EMPTY: Draft = { kind: 'photo', idea: '', prompt: '', aspect: '4:5', model: 'gpt_image_2_5', phase: 'idle', credits: '', note: '' }
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const URL_RE = /https:\/\/[^\s"'<>)\]]+\.(?:png|jpe?g|webp|gif|mp4|mov|webm)(?:\?[^\s"'<>)\]]*)?/gi

async function draft($: EngineInterface) {
  return (await $.state.get(DRAFT)).value ?? EMPTY
}
async function patch($: EngineInterface, p: Partial<Draft>) {
  await $.state.set(DRAFT, { ...(await draft($)), ...p })
}

const textOf = (r: McpToolResult) => r.content.map(c => ('text' in c && typeof c.text === 'string' ? c.text : '')).join('\n')

/** Finds the Higgsfield connector by its likely names, or the one set in settings.json. */
async function server($: EngineInterface) {
  const known = (await $.state.get(SERVER)).value
  if (known) return known
  const set = (await readJson<{ higgsfield?: string }>($, 'settings.json', {})).higgsfield
  for (const name of set ? [set, ...NAMES] : NAMES) {
    try {
      const c = await $.mcp.connect(name)
      if (c.isConnected) {
        await $.state.set(SERVER, c.server)
        return c.server
      }
    } catch {
      // Try the next name.
    }
  }
  return ''
}

async function call($: EngineInterface, tool: string, args: Record<string, unknown>) {
  const s = await server($)
  if (!s) throw new Error('The Higgsfield connector is not connected. Connect it in Claude settings, then try again.')
  const r = await $.mcp.call(s, tool, args)
  const text = textOf(r)
  if (r.isError) throw new Error(text.slice(0, 200) || 'Higgsfield said no')
  return text
}

async function refreshBalance($: EngineInterface) {
  try {
    const t = await call($, 'balance', {})
    const m = /credits?["\s:]*([\d,.]+)/i.exec(t) ?? /([\d,.]+)\s*credits?/i.exec(t)
    await $.state.set(BALANCE, m ? `${m[1]} credits` : cut(t.replace(/\s+/g, ' '), 40))
  } catch (err) {
    await $.state.set(BALANCE, '')
    await log($, NAME, `balance: ${String(err)}`)
  }
}

const params = (d: Draft, extra: Record<string, unknown> = {}) => ({ params: { model: d.model, prompt: d.prompt || d.idea, aspect_ratio: d.aspect, ...extra }, context: 'Higgs Content studio in Claude Code' })

/** Step 2 and 3: upgrade the prompt, then ask Higgsfield what it would cost. */
async function prepare($: EngineInterface, idea: string) {
  const d0 = await draft($)
  await patch($, { idea, prompt: '', credits: '', phase: 'upgrading', note: 'Shaping the prompt…' })
  let prompt = idea
  if (await partOn($, NAME, 'upgrade')) {
    const r = await $.model.complete({
      model: 'claude-haiku-5-5',
      prompt: `Rewrite this idea as one ${d0.kind === 'video' ? 'video' : 'image'} generation prompt for a modern AI ${d0.kind} model, ${d0.aspect} frame. Name the subject, setting, light, lens or camera move, mood, colour and style in one rich paragraph under 90 words. ${d0.kind === 'video' ? 'Describe the motion over time.' : ''} Return only the prompt.\n\nIdea: ${idea}`,
    })
    if (r.isAnswered && r.text.trim()) prompt = r.text.trim()
  }
  await patch($, { prompt, phase: 'quoting', note: 'Checking the cost…' })
  if (!(await partOn($, NAME, 'quote'))) return create($)
  try {
    const t = await call($, d0.kind === 'video' ? 'generate_video' : 'generate_image', params({ ...d0, prompt }, { get_cost: true }))
    const m = /(?:cost|credits?)["\s:]*([\d,.]+)/i.exec(t)
    await patch($, { phase: 'ready', credits: m ? `${m[1]} credits` : cut(t.replace(/\s+/g, ' '), 60), note: '' })
    void refreshBalance($)
  } catch (err) {
    await patch($, { phase: 'failed', note: String(err).replace(/^Error: /, '') })
  }
}

/** Step 4: spend the credits, wait for the result, add it to the gallery. */
async function create($: EngineInterface) {
  const d = await draft($)
  await patch($, { phase: 'creating', note: d.kind === 'video' ? 'Creating the video. This can take a few minutes…' : 'Creating the image…' })
  try {
    const t = await call($, d.kind === 'video' ? 'generate_video' : 'generate_image', params(d, { use_unlim: false }))
    const ids = [...new Set(t.match(UUID) ?? [])].slice(0, 4)
    const shot: Shot = { id: ids[0] ?? `s${Date.now()}`, kind: d.kind, prompt: d.prompt, urls: [...new Set(t.match(URL_RE) ?? [])], status: 'working', at: Date.now() }
    await $.state.set(GALLERY, [shot, ...((await $.state.get(GALLERY)).value ?? [])].slice(0, 24))
    await $.store.set('gallery', (await $.state.get(GALLERY)).value)
    await patch($, { ...EMPTY, kind: d.kind, model: d.model, aspect: d.aspect, note: 'Sent to Higgsfield. It appears in the gallery when ready.' })
    if (shot.urls.length === 0 && ids.length) void poll($, shot.id, ids)
    else await finish($, shot.id, shot.urls, 'ready')
  } catch (err) {
    await patch($, { phase: 'failed', note: String(err).replace(/^Error: /, '') })
  }
}

async function finish($: EngineInterface, id: string, urls: string[], status: string) {
  const g = ((await $.state.get(GALLERY)).value ?? []).map(s => (s.id === id ? { ...s, urls: urls.length ? urls : s.urls, status } : s))
  await $.state.set(GALLERY, g)
  await $.store.set('gallery', g)
  void refreshBalance($)
}

async function poll($: EngineInterface, id: string, ids: string[]) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const t = await call($, 'jobs_wait', { jobs: ids.map((job_id, index) => ({ index, job_id })), timeout_seconds: 15 })
      const urls = [...new Set(t.match(URL_RE) ?? [])]
      if (/fail|error|nsfw|rejected/i.test(t) && urls.length === 0) return finish($, id, [], 'failed')
      if (urls.length || /"all_terminal"\s*:\s*true/.test(t)) return finish($, id, urls, urls.length ? 'ready' : 'done')
    } catch (err) {
      await log($, NAME, `poll: ${String(err)}`)
    }
    await $.clock.sleep(5000)
  }
  return finish($, id, [], 'still working on Higgsfield')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.state.set(GALLERY, ((await $.store.get('gallery')) as Shot[] | undefined) ?? [])
    await $.command.register({ name: 'create', description: 'Higgs Content: make a photo or video with Higgsfield, /create <idea>' })
    return next(e)
  })

  on('command.run', { command: 'create' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Higgs Content' })
    void refreshBalance($)
    const idea = String(e.args ?? '').trim()
    if (idea) {
      if (/\b(video|clip|reel|animation|motion)\b/i.test(idea)) await patch($, { kind: 'video', model: 'seedance_2_5', aspect: '9:16' })
      void prepare($, idea)
    }
    return { text: 'Higgs Content is open.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const cols = Math.max(30, e.props.bodyColumns)
    const d = await draft($)
    const gallery = (await $.state.get(GALLERY)).value ?? []
    const balance = (await $.state.get(BALANCE)).value ?? ''
    const busy = d.phase === 'upgrading' || d.phase === 'quoting' || d.phase === 'creating'
    const chip = (key: string, label: string, isOn: boolean, onPress: () => unknown) => <Button key={key} variant={isOn ? 'primary' : undefined} label={label} onPress={onPress} />
    const parts: RenderChildren[] = [
      <Box key="head" flexDirection="row" columnGap={1} alignItems="center">
        <Text bold size="heading" color={ACCENT}>◐</Text>
        <Text bold size="heading">Higgs Content</Text>
        <Text dimColor>{balance ? `· ${balance}` : '· Higgsfield studio'}</Text>
      </Box>,
      <Box key="kind" flexDirection="row" columnGap={1}>
        {chip('k-photo', 'Photo', d.kind === 'photo', () => patch($, { kind: 'photo', model: 'gpt_image_2_5', aspect: '4:5', phase: 'idle', credits: '' }))}
        {chip('k-video', 'Video', d.kind === 'video', () => patch($, { kind: 'video', model: 'seedance_2_5', aspect: '9:16', phase: 'idle', credits: '' }))}
      </Box>,
      <Box key="models" flexDirection="row" columnGap={1}>
        {MODELS[d.kind].map(m => chip(`m-${m.id}`, m.label, d.model === m.id, () => patch($, { model: m.id, phase: d.prompt ? 'idle' : d.phase, credits: '' })))}
      </Box>,
      <Box key="aspects" flexDirection="row" columnGap={1} alignItems="center">
        <Text dimColor>Frame</Text>
        {ASPECTS.map(a => chip(`a-${a}`, a, d.aspect === a, () => patch($, { aspect: a, credits: '', phase: d.prompt ? 'idle' : d.phase })))}
      </Box>,
    ]
    if ('Input' in ui) {
      const { Input } = ui
      parts.push(<Input key="idea" rows={3} placeholder={d.kind === 'video' ? 'Describe the clip: who, where, what moves…' : 'Describe the picture: subject, place, feeling…'} submitLabel="Shape it" value={d.idea} onSubmit={v => void (v.trim() && prepare($, v.trim()))} />)
    } else {
      parts.push(<Text key="idea-how" dimColor>Type /create and your idea to start.</Text>)
    }
    if (d.note) parts.push(<Text key="note" color={d.phase === 'failed' ? STATUS.bad : busy ? STATUS.info : STATUS.good} wrap="wrap">{busy ? '◌ ' : ''}{d.note}</Text>)
    if (d.prompt && (d.phase === 'ready' || d.phase === 'idle' || d.phase === 'failed')) {
      parts.push(
        <Box key="brief" flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} width={cols}>
          <Text bold>The shot</Text>
          <Text wrap="wrap">{d.prompt}</Text>
          <Text dimColor>{d.kind} · {MODELS[d.kind].find(m => m.id === d.model)?.label ?? d.model} · {d.aspect}{d.credits ? ` · costs ${d.credits}` : ''}</Text>
          <Box flexDirection="row" columnGap={1}>
            {d.phase === 'ready' ? <Button key="go" variant="primary" label={`Create${d.credits ? ` · ${d.credits}` : ''}`} onPress={() => void create($)} /> : <Button key="quote" variant="primary" label="Check the cost" onPress={() => void prepare($, d.idea || d.prompt)} />}
            <Button key="again" label="Rewrite prompt" onPress={() => void prepare($, d.idea || d.prompt)} />
            <Button key="clear" plain dimColor label="Clear" onPress={() => patch($, { ...EMPTY, kind: d.kind, model: d.model, aspect: d.aspect })} />
          </Box>
        </Box>,
      )
    }
    parts.push(<Text key="g-title" bold>Gallery · {gallery.length}</Text>)
    if (gallery.length === 0) parts.push(<Text key="g-none" dimColor>What you create shows up here.</Text>)
    gallery.slice(0, 12).forEach((s, i) => {
      const color = s.status === 'failed' ? STATUS.bad : paletteAt(i + 3)
      parts.push(
        <Box key={`g-${s.id}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={cols}>
          <Text wrap="truncate-end"><Text color={color} bold>{s.kind === 'video' ? '▶' : '■'} </Text>{cut(s.prompt, cols - 8)}</Text>
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor size="caption">{s.status} · {new Date(s.at).toLocaleDateString()}</Text>
            {'Link' in ui ? s.urls.slice(0, 4).map((u, j) => <ui.Link key={`u-${s.id}-${j}`} href={u} label={s.urls.length > 1 ? `Open ${j + 1}` : 'Open'} />) : null}
          </Box>
        </Box>,
      )
    })
    return roomy(<Box flexDirection="column" width={cols}>{parts}</Box>, e.surface)
  })
}
