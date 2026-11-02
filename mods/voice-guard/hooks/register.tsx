// Voice Guard (Solomon Mods): catches AI-sounding writing before it goes out.
// When Claude is about to send, post, publish or draft something through a connector (email,
// Slack, social posts, docs), Voice Guard reads the text for stock AI phrases. If it finds some, you
// choose: Send as is, Rewrite first (Claude rewrites without them), or Cancel.
// /voice <text> checks any text by hand. Written for Solomon Mods.

import type { Register } from 'claude-code'

import { log, partOn } from './suite'

const NAME = 'voice-guard'

// Phrases that make writing read as machine-made. Kept short so real writing is not flagged.
const PHRASES: { re: RegExp; say: string }[] = [
  { re: /\bI hope (this|my) (email|message|note) finds you well\b/i, say: '"I hope this finds you well"' },
  { re: /\bin today'?s (fast-paced|ever-changing|digital|competitive) (world|landscape|age)\b/i, say: '"in today\'s fast-paced world"' },
  { re: /\bdelv(e|es|ing) (into|deeper)\b/i, say: '"delve into"' },
  { re: /\b(rich |vibrant )?tapestry\b/i, say: '"tapestry"' },
  { re: /\ba testament to\b/i, say: '"a testament to"' },
  { re: /\b(game[- ]changer|game[- ]changing)\b/i, say: '"game-changer"' },
  { re: /\bunlock(s|ing)? (the|your|new) (power|potential|full potential)\b/i, say: '"unlock the power of"' },
  { re: /\b(seamless(ly)?|robust|cutting-edge|state-of-the-art|leverag(e|ing)|synerg(y|ies)|elevate)\b/i, say: 'buzzwords (seamless, robust, leverage, elevate)' },
  { re: /\bit'?s not (just|only) (about )?[^.,;]{2,40}[,;] it'?s\b/i, say: '"it\'s not just X, it\'s Y"' },
  { re: /\b(navigat(e|ing) the (complexities|landscape)|ever-evolving landscape)\b/i, say: '"navigate the landscape"' },
  { re: /\b(I'?d be (happy|delighted) to help|feel free to reach out|don'?t hesitate to)\b/i, say: '"don\'t hesitate to reach out"' },
  { re: /\b(Furthermore|Moreover|Additionally),/, say: 'stiff linking words (Furthermore, Moreover)' },
  { re: /\b(In conclusion|In summary|Ultimately),/, say: 'essay endings (In conclusion)' },
  { re: /\b(embark|journey|realm|paradigm|pivotal|crucial|vital)\b/i, say: 'grand words (journey, realm, pivotal)' },
  { re: /^(Great question|Absolutely|Certainly)[!.,]/im, say: 'chatbot openers (Great question!)' },
]
const DASH = /—/g
const SENDS = /(send|post|publish|reply|draft|create_?(draft|post|message|tweet|comment)|tweet|comment|message|email|update_?(page|doc))/i
const SKIP_KEYS = new Set(['tool', 'toolUseId', 'agentId', 'id', 'to', 'cc', 'bcc', 'channel', 'url'])

export function findTells(text: string): string[] {
  const out = PHRASES.filter(p => p.re.test(text)).map(p => p.say)
  const dashes = (text.match(DASH) ?? []).length
  if (dashes >= 3) out.push(`${dashes} long dashes (—)`)
  return out
}

function textOf(e: Record<string, unknown>) {
  const bits: string[] = []
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 4 || SKIP_KEYS.has(key)) return
    if (typeof v === 'string' && v.length > 40) bits.push(v)
    else if (Array.isArray(v)) v.forEach(x => walk(x, key, depth + 1))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1)
  }
  for (const [k, v] of Object.entries(e)) walk(v, k, 0)
  return bits.join('\n\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'voice', description: 'Voice Guard: check text for AI-sounding phrases, /voice <text>' })
    return next(e)
  })

  on('command.run', { command: 'voice' }, async (_$, e) => {
    const text = String(e.args ?? '').trim()
    if (!text) return { text: 'Paste the text after the command, like /voice Hi Sam, ...' }
    const tells = findTells(text)
    return { text: tells.length ? `Sounds AI-written in ${tells.length} place${tells.length === 1 ? '' : 's'}:\n${tells.map(t => `- ${t}`).join('\n')}` : 'Reads like a person wrote it. Nothing flagged.' }
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    if (!tool.startsWith('mcp__') || !SENDS.test(tool.split('__').pop() ?? '') || !(await partOn($, NAME))) return next(e)
    const text = textOf(e as unknown as Record<string, unknown>)
    const tells = text ? findTells(text) : []
    if (tells.length === 0) return next(e)
    const pick = await $.ui.ask(`Voice Guard: this ${tool.split('__').pop()?.replace(/_/g, ' ')} sounds AI-written: ${tells.join(', ')}.`, ['Rewrite first', 'Send as is', 'Cancel'])
    await log($, NAME, `${pick}: ${tool} (${tells.join('; ')})`)
    if (pick === 'Send as is') return next(e)
    if (pick === 'Rewrite first') return { deny: `Voice Guard: rewrite this so it sounds like Joseph wrote it: plain, direct, short sentences. Remove: ${tells.join(', ')}. Then try again.` }
    return { deny: 'Voice Guard: Joseph cancelled this. Do not send it. Ask him what to change.' }
  })
}
