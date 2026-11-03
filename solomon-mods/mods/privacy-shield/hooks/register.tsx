// Privacy Shield (Solomon Mods): what other people see, and what Claude reads.
// - Screen share (written for Solomon Mods; idea credited in SOURCES.md): /screen-share draws emails, phone
//   numbers, amounts, names and keys as shaded bars on screen. Only the drawing changes.
// - Secrets (written for this suite; idea from escapeboy's Secret Redactor, none of its code):
//   keys and tokens in tool output, or pasted into a prompt, reach Claude as ⟦secret-N⟧. When
//   Claude passes ⟦secret-N⟧ back into a tool, the tool gets the real value. The map lives only
//   in memory for this chat and is never written to disk.
// - Key files: reading .env, SSH private keys, .pem/.key files and similar is refused.

import type { EngineInterface, Register } from 'claude-code'

import { BAR, FADE, mask, maskDeep } from './mask'
import { GRADIENT, MARK, SECRET_PATTERNS, isOn, isPartOn, log as suiteLog, readSwitches, writeSwitches, roomy } from './suite'

const NAME = 'privacy-shield'
const ON = { plugin: 'privacy-shield', key: 'on' } as const
const HIDDEN = { plugin: 'privacy-shield', key: 'hidden' } as const
const FADE_MS = 150
const STATUS_TEXT = `${MARK[NAME]} Screen share on`

let sid = ''
let glyph = BAR
const parts = { on: true, screen: true, secrets: true, prompt: true, keyfiles: true }

// value → placeholder, and back. Memory only.
const byValue = new Map<string, string>()
const byToken = new Map<string, string>()
const TOKEN_RE = /⟦secret-(\d+)⟧/g

const log = ($: EngineInterface, line: string) => suiteLog($, NAME, line)

async function readSwitch($: EngineInterface) {
  try {
    const json = await readSwitches($)
    const wasOn = parts.on && parts.screen
    parts.on = isOn(json, NAME)
    parts.screen = isPartOn(json, NAME, 'screen')
    parts.secrets = isPartOn(json, NAME, 'secrets')
    parts.prompt = isPartOn(json, NAME, 'prompt')
    parts.keyfiles = isPartOn(json, NAME, 'keyfiles')
    if (wasOn !== (parts.on && parts.screen)) {
      try {
        $.ui.invalidate('ui.render')
        const { value } = await $.state.get(ON)
        $.ui.status(parts.on && parts.screen && value === true ? STATUS_TEXT : undefined)
      } catch {
        // Only drawing.
      }
    }
  } catch {
    // A broken file changes nothing.
  }
}

// ---------- Secrets ----------

/** Swaps every secret in `text` for its placeholder. Returns the text and how many were new. */
export function hide(text: string): { text: string; count: number } {
  let count = 0
  let out = text
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, hit => {
      if (hit.startsWith('⟦secret-')) return hit
      let token = byValue.get(hit)
      if (!token) {
        token = `⟦secret-${byValue.size + 1}⟧`
        byValue.set(hit, token)
        byToken.set(token, hit)
      }
      count += 1
      return token
    })
  }
  return { text: out, count }
}

/** Puts real values back where Claude wrote a placeholder. */
export function restore(text: string): string {
  if (!text.includes('⟦secret-')) return text
  return text.replace(TOKEN_RE, t => byToken.get(t) ?? t)
}

function deep<T>(value: T, fn: (s: string) => string, depth = 0): { value: T; changed: boolean } {
  if (typeof value === 'string') {
    const v = fn(value)
    return { value: v as T, changed: v !== value }
  }
  if (value === null || typeof value !== 'object' || depth > 30) return { value, changed: false }
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map(v => {
      const r = deep(v, fn, depth + 1)
      if (r.changed) changed = true
      return r.value
    })
    return { value: (changed ? out : value) as T, changed }
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return { value, changed: false }
  let changed = false
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'tool_use_id' || k === 'tool' || k === 'id') {
      out[k] = v
      continue
    }
    const r = deep(v, fn, depth + 1)
    if (r.changed) changed = true
    out[k] = r.value
  }
  return { value: (changed ? out : value) as T, changed }
}

async function countHidden($: EngineInterface, n: number) {
  if (!n) return
  const { value } = await $.state.get(HIDDEN)
  await $.state.set(HIDDEN, (value ?? 0) + n)
}

// ---------- Key files ----------

const KEY_NAME_RE = /^(?:\.env(?:\.(?!example$|sample$|template$|dist$)[\w.-]+)?|id_(?:rsa|dsa|ecdsa|ed25519)|\.netrc|\.pgpass|credentials|\.git-credentials|.+\.(?:pem|key|p12|pfx|keystore|jks|ppk))$/i
const READERS = /(?:^|[\s;|&(])(?:cat|less|more|head|tail|bat|grep|rg|awk|sed|strings|xxd|od|base64|source|\.|cp|scp|curl\s+.*-d\s*@|open)\s/

/** The key file a tool call would read, or ''. */
export function keyFileOf(tool: string, input: Record<string, unknown>): string {
  const pathOk = (p: unknown) => {
    if (typeof p !== 'string' || !p) return ''
    const base = p.split('/').pop() ?? ''
    if (/\.pub$/.test(base)) return ''
    if (KEY_NAME_RE.test(base)) return p
    if (/\/\.ssh\/[^/]+$/.test(p) && !/\/(?:known_hosts|config|authorized_keys)$/.test(p)) return p
    if (/\/\.aws\/credentials$|\/\.config\/gcloud\/.*\.json$/.test(p)) return p
    return ''
  }
  if (tool === 'Read' || tool === 'NotebookRead') return pathOk(input.file_path ?? input.notebook_path)
  if (tool === 'Grep' || tool === 'Glob') return pathOk(input.path)
  if (tool === 'Bash' && typeof input.command === 'string' && READERS.test(` ${input.command}`)) {
    for (const word of input.command.split(/[\s;|&()<>"'`]+/)) {
      const hit = pathOk(word)
      if (hit) return hit
    }
  }
  return ''
}

// ---------- Screen share ----------

async function screenOn($: EngineInterface) {
  if (!parts.on || !parts.screen) return false
  return (await $.state.get(ON)).value === true
}

const secretBars = (text: string) => {
  let out = text
  for (const { re } of SECRET_PATTERNS) out = out.replace(re, hit => hit.replace(/\S/g, glyph))
  return out
}
const screenMask = (text: string) => (typeof text === 'string' ? secretBars(mask(text, glyph)) : text)
const screenMaskDeep = <T,>(v: T): T => deep(maskDeep(v, glyph), s => secretBars(s)).value

async function setMode($: EngineInterface, on: boolean) {
  glyph = on ? FADE : BAR
  await $.state.set(ON, on)
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // The state write redraws anyway.
  }
  if (on) {
    $.clock.after(FADE_MS, () => {
      glyph = BAR
      try {
        $.ui.invalidate('ui.render')
      } catch {
        // Only drawing.
      }
    })
  }
  try {
    $.ui.status(on ? STATUS_TEXT : undefined)
  } catch {
    // Only drawing.
  }
  if (sid) await $.store.set(`on:${sid}`, on).catch(() => undefined)
}

// ---------- Hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'screen-share', description: 'Privacy Shield: hide emails, phones, amounts, names and keys on screen while you share it (Claude still reads the real data)', argumentHint: '[on|off]', immediate: true })
    await $.command.register({ name: 'privacy', description: 'Privacy Shield: what is hidden now, and switch parts. "/privacy keyfiles off" allows reading key files', argumentHint: '[secrets|prompt|keyfiles on|off]', immediate: true })
    sid = await $.session.id()
    await readSwitch($)
    $.clock.every(3000, () => {
      void readSwitch($)
    })
    if ((await $.store.get(`on:${sid}`).catch(() => undefined)) === true && parts.on && parts.screen) {
      await $.state.set(ON, true)
      $.ui.status(STATUS_TEXT)
    }
    return next(e)
  })

  // Secrets pasted into a prompt reach Claude as placeholders.
  on('prompt.submit', async ($, e, next) => {
    if (!parts.on || !parts.prompt || !e.text) return next(e)
    const h = hide(e.text)
    if (!h.count) return next(e)
    await countHidden($, h.count)
    try {
      $.ui.toast(`Privacy Shield: ${h.count === 1 ? 'a key' : `${h.count} keys`} in your message reach Claude as ⟦secret-N⟧. Tools still get the real value.`)
    } catch {
      // Only a hint.
    }
    return next({ ...e, text: h.text })
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (!parts.on) return next(e)
    const input = e as unknown as Record<string, unknown>
    if (parts.keyfiles) {
      const file = keyFileOf(String(e.tool), input)
      if (file) {
        await log($, `blocked reading ${file}`)
        return { deny: `Privacy Shield blocked reading ${file}: it is a file that holds keys or passwords. Do not try another way to read it. If the user needs it read, tell them they can type "/privacy keyfiles off" first.` }
      }
    }
    // Placeholders Claude passes back become real values for the tool only.
    const back = byToken.size ? deep(e, restore) : { value: e, changed: false }
    const r = await next(back.changed ? back.value : e)
    if (!parts.secrets || !('result' in r) || r.deny !== undefined) return r
    const said = typeof r.text === 'string' ? r.text : ''
    const looks = said ? SECRET_PATTERNS.some(({ re }) => new RegExp(re.source, re.flags.replace('g', '')).test(said)) : true
    if (!looks) return r
    let n = 0
    const hideCount = (s: string) => {
      const h = hide(s)
      n += h.count
      return h.text
    }
    const result = deep(r.result, hideCount)
    if (!result.changed) return r
    await countHidden($, n)
    await log($, `hid ${n} secret(s) in ${String(e.tool)} output`)
    return { result: result.value, ...(r.context ? { context: r.context } : {}) } as never
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'screen-share' }, async ($, e) => {
    if (!parts.on || !parts.screen) return { text: 'Screen share is switched off in /mods (Privacy Shield).' }
    const arg = e.args.trim().toLowerCase()
    const want = arg === 'on' ? true : arg === 'off' ? false : !(await screenOn($))
    await setMode($, want)
    return { text: want ? 'Screen share on: emails, phone numbers, amounts, names and keys show as shaded bars. Claude still reads the real data. /screen-share again turns it off.' : 'Screen share off. Everything shows as normal.' }
  })

  on('command.run', { command: 'privacy' }, async ($, e) => {
    const m = /^(secrets|prompt|keyfiles|screen)\s+(on|off)$/.exec(e.args.trim().toLowerCase())
    if (m) {
      const json = await readSwitches($, true)
      json[`${NAME}:${m[1]}`] = m[2] === 'on'
      await writeSwitches($, json)
      await readSwitch($)
    }
    const { value } = await $.state.get(HIDDEN)
    const line = (lit: boolean, what: string) => `${lit ? '●' : '○'} ${what}`
    return {
      text: [
        `${MARK[NAME]} Privacy Shield${parts.on ? '' : ' (off in /mods)'}`,
        line(await screenOn($), 'Screen share masking (/screen-share)'),
        line(parts.secrets, `Keys in tool output hidden from Claude · ${value ?? 0} hidden this chat`),
        line(parts.prompt, 'Keys you paste hidden from Claude'),
        line(parts.keyfiles, 'Key files (.env, SSH keys, .pem) blocked'),
        'Change one: /privacy keyfiles off (or secrets, prompt, screen; on or off)',
      ].join('\n'),
    }
  })

  on('ui.press', { plugin: 'privacy-shield', element: 'off' }, async ($, e) => {
    await setMode($, false)
    return { element: e.element }
  })

  // The transcript rows: only the drawing changes.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!(await screenOn($))) return next(e)
    const text = screenMask(e.props.text)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await screenOn($))) return next(e)
    const text = screenMask(e.props.text)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (!(await screenOn($))) return next(e)
    const text = screenMask(e.props.text)
    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await screenOn($))) return next(e)
    const input = screenMaskDeep(e.props.input)
    const output = screenMaskDeep(e.props.output)
    if (input === e.props.input && output === e.props.output) return next(e)
    return next({ ...e, props: { ...e.props, input, output } })
  })
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await screenOn($))) return next(e)
    const output = screenMaskDeep(e.props.output)
    return output === e.props.output ? next(e) : next({ ...e, props: { ...e.props, output } })
  })
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await screenOn($))) return next(e)
    const calls = screenMaskDeep(e.props.calls)
    return calls === e.props.calls ? next(e) : next({ ...e, props: { ...e.props, calls } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => roomy(await (async () => {
    if (e.props.hasSurvey || !(await screenOn($))) return next(e)
    const rest = await next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rest}
        <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1}>
          <Text wrap="truncate-end">
            <Text bold color={GRADIENT[2]}>{`${MARK[NAME]} `}</Text>
            <Text bold>Screen share on</Text>
            <Text dimColor> · emails, phones, amounts, names and keys hidden on screen</Text>
          </Text>
          <Button key="off" label="Turn off" onPress={() => undefined} />
        </Box>
      </Box>
    )
  })(), e.surface))
}
