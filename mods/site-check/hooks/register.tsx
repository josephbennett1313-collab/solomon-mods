// Site Check (Solomon Mods): /sitecheck <url> scores a website for speed, SEO, accessibility and
// best practice, using Google's free PageSpeed Insights (Lighthouse), so nothing is installed.
// The card above the prompt shows four coloured scores and the biggest fixes in plain words, with a
// button that asks Claude to explain or make the fixes. Written for Solomon Mods.

import type { EngineInterface, Register } from 'claude-code'

import type { Fix, Report, Score } from '../types'
import { ACCENT, STATUS, barCells, cut, log, partOn, roomy } from './suite'

const NAME = 'site-check'
const REPORT = { plugin: 'site-check', key: 'report' } as const
const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
const CATS: [string, string][] = [
  ['performance', 'Speed'],
  ['seo', 'SEO'],
  ['accessibility', 'Accessibility'],
  ['best-practices', 'Best practice'],
]

const colorOf = (s: number) => (s >= 90 ? STATUS.good : s >= 50 ? STATUS.warn : STATUS.bad)

function normal(raw: string) {
  const t = raw.trim()
  if (!t) return ''
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

type Lh = {
  lighthouseResult?: {
    categories?: Record<string, { score: number | null; auditRefs?: { id: string; weight: number }[] }>
    audits?: Record<string, { title: string; description?: string; score: number | null; scoreDisplayMode?: string; displayValue?: string }>
  }
  error?: { message?: string }
}

async function run($: EngineInterface, url: string, device: 'mobile' | 'desktop') {
  await $.state.set(REPORT, { url, phase: 'running', device, scores: [], fixes: [], note: `Checking ${url} on ${device}. This takes 20 to 60 seconds…`, at: Date.now() })
  try {
    const q = [`url=${encodeURIComponent(url)}`, `strategy=${device}`, ...CATS.map(([k]) => `category=${k}`)].join('&')
    const r = await $.process.run(['curl', '-sS', '--max-time', '120', `${API}?${q}`])
    const json = JSON.parse(String(r.stdout ?? '{}')) as Lh
    if (json.error || !json.lighthouseResult) throw new Error(json.error?.message ?? 'no result')
    const cats = json.lighthouseResult.categories ?? {}
    const audits = json.lighthouseResult.audits ?? {}
    const scores: Score[] = CATS.map(([key, label]) => ({ key, label, score: Math.round((cats[key]?.score ?? 0) * 100) }))
    const fixes: Fix[] = []
    for (const [key, label] of CATS) {
      for (const ref of [...(cats[key]?.auditRefs ?? [])].sort((a, b) => b.weight - a.weight)) {
        const a = audits[ref.id]
        if (!a || a.score === null || a.score >= 0.9 || a.scoreDisplayMode === 'notApplicable' || a.scoreDisplayMode === 'informative') continue
        if (fixes.some(f => f.title === a.title)) continue
        fixes.push({ title: a.title, detail: (a.displayValue ?? '').trim(), group: label })
        if (fixes.filter(f => f.group === label).length >= 3) break
      }
    }
    await $.state.set(REPORT, { url, phase: 'done', device, scores, fixes: fixes.slice(0, 8), note: '', at: Date.now() })
  } catch (err) {
    await log($, NAME, `check ${url}: ${String(err)}`)
    await $.state.set(REPORT, { url, phase: 'failed', device, scores: [], fixes: [], note: `The check did not finish: ${String(err).slice(0, 140)}. Google's free checker allows a few runs a minute; try again shortly.`, at: Date.now() })
  }
}

function brief(r: Report) {
  return [
    `Site Check (Google Lighthouse, ${r.device}) for ${r.url}:`,
    ...r.scores.map(s => `- ${s.label}: ${s.score}/100`),
    '',
    'Biggest fixes:',
    ...r.fixes.map(f => `- [${f.group}] ${f.title}${f.detail ? ` (${f.detail})` : ''}`),
    '',
    'Explain each fix in plain words, say which matter most for visitors and Google, and if this site is in this project, make the fixes.',
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sitecheck', description: 'Site Check: score a website for speed, SEO and accessibility, /sitecheck <url>' })
    return next(e)
  })

  on('command.run', { command: 'sitecheck' }, async ($, e) => {
    if (!(await partOn($, NAME))) return { text: 'Site Check is switched off in /mods.' }
    const args = String(e.args ?? '').trim().split(/\s+/)
    const device = args.includes('desktop') ? 'desktop' : 'mobile'
    const url = normal(args.find(a => a !== 'desktop' && a !== 'mobile') ?? '')
    if (!url) return { text: 'Give the site after the command, like /sitecheck example.com (add "desktop" to test the desktop version).' }
    void run($, url, device)
    return { text: `Checking ${url}. The scores appear above the prompt.` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = (await $.state.get(REPORT)).value
    if (!r) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = Math.max(40, (e.props.bodyColumns ?? 100) - 4)
    const barW = Math.max(8, Math.min(24, Math.floor(width / 4) - 6))
    return roomy(
      <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
        <Box flexDirection="row" columnGap={1}>
          <Text bold color={ACCENT}>Site Check</Text>
          <Text dimColor wrap="truncate-end">{cut(r.url, width - 30)} · {r.device}</Text>
          <Button key="sc-x" plain label="×" onPress={() => $.state.set(REPORT, null)} />
        </Box>
        {r.note ? <Text dimColor={r.phase === 'running'} color={r.phase === 'failed' ? STATUS.bad : undefined}>{r.note}</Text> : null}
        {r.scores.map(s => {
          const { fill, rest } = barCells(s.score / 100, barW)
          return (
            <Text key={`sc-${s.key}`}>
              <Text color={colorOf(s.score)} bold>{String(s.score).padStart(3)}</Text> <Text color={colorOf(s.score)}>{'█'.repeat(fill.length)}</Text>
              <Text dimColor>{'░'.repeat(rest)}</Text> {s.label}
            </Text>
          )
        })}
        {r.fixes.length ? <Text bold>Biggest fixes</Text> : null}
        {r.fixes.map((f, i) => (
          <Text key={`fx-${i}`} wrap="truncate-end">
            <Text color={STATUS.warn}>●</Text> {cut(f.title, width - 24)} <Text dimColor>· {f.group}{f.detail ? ` · ${f.detail}` : ''}</Text>
          </Text>
        ))}
        {r.phase === 'done' ? (
          <Box flexDirection="row" columnGap={1}>
            <Button key="sc-ask" variant="primary" label="Ask Claude to explain and fix" onPress={() => $.prompt.submit({ text: brief(r), asUser: true })} />
            <Button key="sc-other" label={r.device === 'mobile' ? 'Check desktop' : 'Check mobile'} onPress={() => void run($, r.url, r.device === 'mobile' ? 'desktop' : 'mobile')} />
          </Box>
        ) : null}
        {r.phase === 'failed' ? <Button key="sc-retry" label="Try again" onPress={() => void run($, r.url, r.device)} /> : null}
      </Box>,
      e.surface,
    )
  })
}
