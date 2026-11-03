// Command Guard (Solomon Mods): holds risky shell commands until you press Proceed.
// Delete-everything, force push, hard reset, wiping a disk, piping a download into a shell and
// the like stop and ask first, with a plain explanation of what could be lost.
// /guard lists what it watches for and what it held in this chat. Written for Solomon Mods.

import type { Register } from 'claude-code'

import { log, partOn } from './suite'

const NAME = 'command-guard'

const RISKS: { re: RegExp; what: string }[] = [
  { re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--recursive\s+--force|-r\s+-f|-f\s+-r)\b/, what: 'deletes files and folders for good, with no trash to recover from' },
  { re: /\bgit\s+push\b[^\n]*(--force\b|-f\b|--force-with-lease\b)/, what: 'overwrites the history on GitHub; other people’s work can be lost' },
  { re: /\bgit\s+reset\s+--hard\b/, what: 'throws away every change that is not committed' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, what: 'deletes files git is not tracking, for good' },
  { re: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, what: 'throws away every unsaved change in the folder' },
  { re: /\bgit\s+branch\s+-D\b/, what: 'deletes a branch even if its work was never merged' },
  { re: /\bgit\s+filter-(branch|repo)\b/, what: 'rewrites the whole history of the project' },
  { re: /\b(drop|truncate)\s+(table|database|schema)\b/i, what: 'deletes a database table or database' },
  { re: /\bdelete\s+from\s+\w+\s*;?\s*$/i, what: 'deletes every row in a table (no WHERE)' },
  { re: /\b(mkfs|diskutil\s+(erase|zero|partition))/i, what: 'erases a disk' },
  { re: /\bdd\s+[^\n]*\bof=\/dev\//, what: 'writes straight over a disk' },
  { re: /\bchmod\s+-R\s+777\b/, what: 'lets anyone change every file in the folder' },
  { re: /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z)?sh\b/, what: 'runs a script from the internet without reading it first' },
  { re: /\bsudo\b/, what: 'runs with full admin rights over the Mac' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/, what: 'publishes a package to the public registry' },
  { re: /\bgh\s+repo\s+delete\b/, what: 'deletes a GitHub repository' },
  { re: /\bkill\s+-9\s+-1\b|\bkillall\b/, what: 'stops many programs at once' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, what: 'freezes the computer' },
]

const held: { at: number; command: string; what: string; choice: string }[] = []

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'guard', description: 'Command Guard: what it watches for, and what it held in this chat' })
    return next(e)
  })

  on('command.run', { command: 'guard' }, async () => {
    const lines = ['Command Guard asks before a shell command that:', ...RISKS.map(r => `- ${r.what}`)]
    if (held.length) lines.push('', 'Held in this chat:', ...held.map(h => `- ${h.choice}: ${h.command.slice(0, 80)}`))
    return { text: lines.join('\n') }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!(await partOn($, NAME))) return next(e)
    const hits = RISKS.filter(r => r.re.test(e.command))
    if (hits.length === 0) return next(e)
    const why = hits.map(h => h.what).join('; and it ')
    const shown = e.command.length > 160 ? `${e.command.slice(0, 159)}…` : e.command
    const pick = await $.ui.ask(`Command Guard: Claude wants to run\n\n${shown}\n\nThis ${why}. Run it?`, ['Proceed', 'Cancel']).catch(() => 'Cancel')
    held.push({ at: Date.now(), command: e.command, what: why, choice: pick === 'Proceed' ? 'Allowed' : 'Stopped' })
    await log($, NAME, `${pick === 'Proceed' ? 'allowed' : 'stopped'}: ${e.command.slice(0, 200)}`)
    if (pick === 'Proceed') return next(e)
    return { deny: `Command Guard: Joseph stopped this command because it ${why}. Find a safer way, or explain why it is needed and ask him.` }
  })
}
