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

/** What this chat has done so far, for the facts row. */
export type Facts = { startedAt: number; tools: number; edits: number; compactions: number; branch: string }

/** Auto Model's fast mode and Ultracode for this chat: auto, on or off (shared with Auto Model). */
export type AmMode = 'auto' | 'on' | 'off'
export type AmModes = { fast: AmMode; ultracode: AmMode; at: number }

/** Auto Model's values this panel reads (Auto Model owns and writes them). */
export type AutoPick = { model: string; effort: string; fast: boolean; ultracode: boolean; tier: string; why: string; compacted: boolean; at: number }
export type AutoLive = { installed: boolean; fast: boolean; ultracode: boolean; model: string; switching: string }

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
      min: boolean
      hidden: boolean
      facts: Facts | null
      /** True while this panel draws Auto Model's row, so Auto Model draws no chip of its own. */
      hosting: boolean
      /** The fast mode and Ultracode choices made on this panel for this chat. */
      amModes: AmModes | null
    }
    'auto-model': {
      pick: AutoPick | null
      live: AutoLive | null
      modes: AmModes | null
    }
  }
}
