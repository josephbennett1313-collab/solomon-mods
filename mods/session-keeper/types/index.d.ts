export type Bar = {
  /** Last tick, ms; the bar redraws on it. */
  now: number
  /** When the last main-chat reply ended, ms; 0 before the first. */
  lastEnd: number
  /** How long the cache stays warm after a reply. */
  ttlMs: number
  ttlKnown: boolean
  /** Context the next message re-sends, and how full the window is. */
  tokens: number
  percent: number
  /** /cost total for this chat, US dollars. */
  sessionUsd: number
  fiveHour: number | null
  week: number | null
  /** The model the last request used, as the engine named it. */
  model: string
  fast: boolean
}

export type Tip = { command: string; label: string; why: string }

export type Suggest = { main: Tip; others: Tip[] }

export type Hold = { text: string; nowUsd: number; warmUsd: number; coldMins: number; tokens: number }

export type Device = 'Mac mini' | 'MacBook' | 'iPhone'

export type Handoff = {
  phase: 'pick' | 'working' | 'ready' | 'failed'
  device: Device | ''
  file: string
  text: string
  note: string
}

declare module 'claude-code' {
  interface PluginState {
    'session-keeper': {
      bar: Bar | null
      suggest: Suggest | null
      hold: Hold | null
      handoff: Handoff | null
      expanded: boolean
      note: string
      warmUntil: number
    }
  }
}
