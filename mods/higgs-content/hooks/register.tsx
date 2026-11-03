// Higgs Content (Solomon Mods): a clean photo and video studio for your Higgsfield connector.
// 1. Pick photo or video, the look and the frame, then describe it (or type /create <idea>).
// 2. Shape it: a small model turns the idea into a proper shot brief you can read and redo.
// 3. Check the cost: Claude asks Higgsfield for the credit cost and your balance. Nothing is spent.
// 4. Create: only when you press it does Claude make it on Higgsfield. Results land in the gallery.
// Claude makes the Higgsfield calls itself, so it uses the connector you added to Claude, whatever
// its name. Written for Solomon Mods.

import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Draft, Kind, Shot } from '../types'
import { ACCENT, STATUS, cut, log, paletteAt, partOn, roomy } from './suite'

const NAME = 'higgs-content'
const PANE = 'higgs-content'
const DRAFT = { plugin: 'higgs-content', key: 'draft' } as const
const GALLERY = { plugin: 'higgs-content', key: 'gallery' } as const
const BALANCE = { plugin: 'higgs-content', key: 'balance' } as const
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
const URL_RE = /https:\/\/[^\s"'<>)\]\\]+\.(?:png|jpe?g|webp|gif|mp4|mov|webm)(?:\?[^\s"'<>)\]\\]*)?/gi
// The Higgsfield tools Claude calls, whatever the connector is named.
const HIGGS = /^mcp__.+__(generate_image|generate_video|balance|jobs_wait|show_generation_by_ids|show_generations)$/
const toolOf = (kind: Kind) => (kind === 'video' ? 'generate_video' : 'generate_image')

async function draft($: EngineInterface) {
  return (await $.state.get(DRAFT)).value ?? EMPTY
}
async function patch($: EngineInterface, p: Partial<Draft>) {
  await $.state.set(DRAFT, { ...(await draft($)), ...p })
}
async function gallery($: EngineInterface) {
  return (await $.state.get(GALLERY)).value ?? []
}
async function saveGallery($: EngineInterface, g: Shot[]) {
  await $.state.set(GALLERY, g.slice(0, 24))
  await $.store.set('gallery', g.slice(0, 24))
}
/** Changes the newest shot that is still being made. */
async function updateWorking($: EngineInterface, fn: (s: Shot) => Shot) {
  const g = await gallery($)
  const i = g.findIndex(s => s.status === 'working')
  if (i < 0) return
  await saveGallery($, g.map((s, j) => (j === i ? fn(s) : s)))
}

const spec = (d: Draft) => `model "${d.model}", aspect_ratio "${d.aspect}", and this prompt:\n\n${d.prompt || d.idea}`

/** Step 2: turn the idea into a shot brief. */
async function shape($: EngineInterface, idea: string) {
  const d0 = await draft($)
  await patch($, { idea, prompt: '', credits: '', phase: 'upgrading', note: 'Shaping the shot…' })
  let prompt = idea
  if (await partOn($, NAME, 'upgrade')) {
    try {
      const r = await $.model.complete({
        model: 'claude-haiku-5-5',
        prompt: `Rewrite this idea as one ${d0.kind === 'video' ? 'video' : 'image'} generation prompt for a modern AI ${d0.kind} model, ${d0.aspect} frame. Name the subject, setting, light, lens or camera move, mood, colour and style in one rich paragraph under 90 words. ${d0.kind === 'video' ? 'Describe the motion over time.' : ''} Return only the prompt.\n\nIdea: ${idea}`,
      })
      if (r.isAnswered && r.text.trim()) prompt = r.text.trim()
    } catch (err) {
      await log($, NAME, `shape: ${String(err)}`)
    }
  }
  await patch($, { prompt, phase: 'idle', note: '' })
}

/** Step 3: Claude asks Higgsfield for the cost. Nothing is made. */
async function quote($: EngineInterface) {
  const d = await draft($)
  if (!(await partOn($, NAME, 'quote'))) return create($)
  await patch($, { phase: 'quoting', credits: '', note: 'Claude is asking Higgsfield for the cost. Nothing is spent.' })
  await $.prompt.submit({
    text: `Higgs Content: check the cost only. Use the Higgsfield connector: call ${toolOf(d.kind)} with params.get_cost set to true, ${spec(d)}\n\nThen call balance. Reply in one line with the credit cost and my balance. Do not create anything yet.`,
    asUser: true,
  })
}

/** Step 4: after the person presses Create, Claude makes it on Higgsfield. */
async function create($: EngineInterface) {
  const d = await draft($)
  await patch($, { phase: 'creating', note: d.kind === 'video' ? 'Claude is creating the video on Higgsfield. This can take a few minutes.' : 'Claude is creating the image on Higgsfield.' })
  await saveGallery($, [{ id: `s${Date.now()}`, kind: d.kind, prompt: d.prompt || d.idea, urls: [], status: 'working', at: Date.now() }, ...(await gallery($))])
  await $.prompt.submit({
    text: `Higgs Content: I approve${d.credits ? ` spending ${d.credits}` : ''}. Use the Higgsfield connector to create this ${d.kind} now: call ${toolOf(d.kind)} with ${spec(d)}\n\nThen wait for it with jobs_wait and give me the link to the result.`,
    asUser: true,
  })
}

/** Reads what Higgsfield answered Claude: the cost, the balance, the finished links. */
async function observe($: EngineInterface, tool: string, input: string, output: string) {
  const num = (re: RegExp) => re.exec(output)?.[1]
  if (tool === 'balance') {
    const n = num(/(?:credits?|balance)[\\"\s:]*(\d[\d,.]*)/i) ?? num(/(\d[\d,.]*)\s*credits?/i)
    if (n) await $.state.set(BALANCE, `${n} credits`)
    return
  }
  const urls = [...new Set(output.match(URL_RE) ?? [])]
  if (tool === 'generate_image' || tool === 'generate_video') {
    if (/get_cost[\\"\s:]*true/i.test(input)) {
      const n = num(/(?:cost|credits?|price)[\\"\s:]*(\d[\d,.]*)/i)
      await patch($, { phase: 'ready', credits: n ? `${n} credits` : '', note: n ? '' : 'Claude shows the cost in the chat.' })
      return
    }
    await updateWorking($, s => ({ ...s, urls: urls.length ? urls : s.urls, status: urls.length ? 'ready' : 'working' }))
    const d = await draft($)
    await patch($, { ...EMPTY, kind: d.kind, model: d.model, aspect: d.aspect, note: 'Sent to Higgsfield. It shows in the gallery when it is ready.' })
    return
  }
  if (urls.length) await updateWorking($, s => ({ ...s, urls, status: 'ready' }))
  else if (/"status"[\\"\s:]*"?(failed|nsfw|rejected)/i.test(output)) await updateWorking($, s => ({ ...s, status: 'failed' }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.state.set(GALLERY, ((await $.store.get('gallery')) as Shot[] | undefined) ?? [])
    await $.command.register({ name: 'create', description: 'Higgs Content: make a photo or video with Higgsfield, /create <idea>' })
    return next(e)
  })

  on('command.run', { command: 'create' }, async ($, e) => {
    if (!(await partOn($, NAME))) return { text: 'Higgs Content is off. Turn it on in /mods.' }
    await $.ui.open({ id: PANE, title: 'Higgs Content' })
    const idea = String(e.args ?? '').trim()
    if (idea) {
      if (/\b(video|clip|reel|animation|motion)\b/i.test(idea)) await patch($, { kind: 'video', model: 'seedance_2_5', aspect: '9:16' })
      void shape($, idea)
    }
    return { text: 'Higgs Content is open.' }
  })

  // Claude's Higgsfield calls fill in the cost, the balance and the gallery.
  on('tool.call', async ($, e, next) => {
    const m = HIGGS.exec(String(e.tool))
    if (!m || !(await partOn($, NAME))) return next(e)
    const r = await next(e)
    try {
      await observe($, m[1]!, JSON.stringify(e), JSON.stringify(r))
    } catch (err) {
      await log($, NAME, `observe: ${String(err)}`)
    }
    return r
  })

  // When Claude's reply ends, a studio still waiting goes back to a state you can act on.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const d = await draft($)
    if (d.phase === 'quoting') await patch($, { phase: 'ready', note: d.credits ? '' : 'See Claude’s reply for the cost.' })
    if (d.phase === 'creating') await patch($, { phase: 'idle', note: 'See Claude’s reply. Anything made shows in the gallery.' })
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const cols = Math.max(30, e.props.bodyColumns)
    if (!(await partOn($, NAME))) return <Text dimColor>Higgs Content is switched off. Turn it on in /mods.</Text>
    const d = await draft($)
    const shots = await gallery($)
    const balance = (await $.state.get(BALANCE)).value ?? ''
    const busy = d.phase === 'upgrading' || d.phase === 'quoting' || d.phase === 'creating'
    const chip = (key: string, label: string, isOn: boolean, onPress: () => unknown) => <Button key={key} variant={isOn ? 'primary' : undefined} label={label} onPress={onPress} />
    const label = (text: string) => <Text key={`l-${text}`} dimColor bold size="caption">{text}</Text>
    const reset = { phase: 'idle' as const, credits: '' }
    const parts: RenderChildren[] = [
      <Box key="head" flexDirection="row" columnGap={1} alignItems="center" justifyContent="space-between" width={cols}>
        <Box flexDirection="row" columnGap={1} alignItems="center">
          <Text bold size="heading" color={ACCENT}>✺</Text>
          <Text bold size="heading">Higgs Content</Text>
        </Box>
        <Text dimColor>{balance || 'Higgsfield studio'}</Text>
      </Box>,
      label('TYPE'),
      <Box key="kind" flexDirection="row" columnGap={1}>
        {chip('k-photo', 'Photo', d.kind === 'photo', () => patch($, { kind: 'photo', model: 'gpt_image_2_5', aspect: '4:5', ...reset }))}
        {chip('k-video', 'Video', d.kind === 'video', () => patch($, { kind: 'video', model: 'seedance_2_5', aspect: '9:16', ...reset }))}
      </Box>,
      label('LOOK'),
      <Box key="models" flexDirection="row" columnGap={1}>
        {MODELS[d.kind].map(m => chip(`m-${m.id}`, m.label, d.model === m.id, () => patch($, { model: m.id, ...reset })))}
      </Box>,
      label('FRAME'),
      <Box key="aspects" flexDirection="row" columnGap={1}>
        {ASPECTS.map(a => chip(`a-${a}`, a, d.aspect === a, () => patch($, { aspect: a, ...reset })))}
      </Box>,
      label('IDEA'),
    ]
    if ('Input' in ui) {
      const { Input } = ui
      parts.push(<Input key="idea" rows={3} placeholder={d.kind === 'video' ? 'Describe the clip: who, where, what moves…' : 'Describe the picture: subject, place, feeling…'} submitLabel="Shape it" value={d.idea} onSubmit={v => void (v.trim() && shape($, v.trim()))} />)
    } else {
      parts.push(<Text key="idea-how" dimColor>Type /create and your idea to start.</Text>)
    }
    if (d.note) parts.push(<Text key="note" color={busy ? STATUS.info : STATUS.good} wrap="wrap">{busy ? '◌ ' : ''}{d.note}</Text>)
    if (d.prompt && d.phase !== 'upgrading') {
      parts.push(
        <Box key="brief" flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1} width={cols}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>The shot</Text>
            <Text dimColor>{d.kind} · {MODELS[d.kind].find(m => m.id === d.model)?.label ?? d.model} · {d.aspect}</Text>
          </Box>
          <Text wrap="wrap">{d.prompt}</Text>
          {d.credits ? <Text color={ACCENT} bold>{`Costs ${d.credits}${balance ? ` · you have ${balance}` : ''}`}</Text> : null}
          <Box flexDirection="row" columnGap={1}>
            {d.phase === 'ready' ? <Button key="go" variant="primary" label={`Create${d.credits ? ` · ${d.credits}` : ''}`} onPress={() => void create($)} /> : null}
            {d.phase === 'idle' ? <Button key="quote" variant="primary" label="Check the cost" onPress={() => void quote($)} /> : null}
            {!busy ? <Button key="again" label="Reshape" onPress={() => void shape($, d.idea || d.prompt)} /> : null}
            <Button key="clear" plain dimColor label="Clear" onPress={() => patch($, { ...EMPTY, kind: d.kind, model: d.model, aspect: d.aspect })} />
          </Box>
        </Box>,
      )
    }
    parts.push(<Text key="g-title" bold>{`Gallery · ${shots.length}`}</Text>)
    if (shots.length === 0) parts.push(<Text key="g-none" dimColor>What you create shows up here.</Text>)
    shots.slice(0, 12).forEach((s, i) => {
      const color = s.status === 'failed' ? STATUS.bad : paletteAt(i + 3)
      parts.push(
        <Box key={`g-${s.id}`} flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={cols}>
          <Text wrap="truncate-end"><Text color={color} bold>{s.kind === 'video' ? '▶ ' : '■ '}</Text>{cut(s.prompt, cols - 8)}</Text>
          <Box flexDirection="row" columnGap={1}>
            <Text dimColor size="caption">{s.status} · {new Date(s.at).toLocaleDateString()}</Text>
            {'Link' in ui ? s.urls.slice(0, 4).map((u, j) => <ui.Link key={`u-${s.id}-${j}`} href={u} label={s.urls.length > 1 ? `Open ${j + 1}` : 'Open'} />) : null}
          </Box>
        </Box>,
      )
    })
    return roomy(<Box flexDirection="column" width={cols} gap="sm">{parts}</Box>, e.surface)
  })
}
