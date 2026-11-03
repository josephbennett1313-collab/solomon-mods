export type Pick = {
  model: string
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  fast: boolean
  ultracode: boolean
  tier: string
  why: string
  compacted: boolean
  at: number
}

/** What is on in this chat right now, as Auto Model last saw it (Session Keeper's panel reads it). */
export type Live = {
  installed: boolean
  fast: boolean
  ultracode: boolean
  model: string
  /** The model a held message is waiting on; empty when none. */
  switching: string
}

/** Fast mode and Ultracode for this chat: auto, on or off. */
export type AmMode = 'auto' | 'on' | 'off'
export type AmModes = { fast: AmMode; ultracode: AmMode; at: number }

declare module 'claude-code' {
  interface PluginState {
    'auto-model': {
      pick: Pick | null
      live: Live | null
      /** The choices made with the chip's buttons (or by typing /fast or /effort ultracode). */
      modes: AmModes | null
    }
    /** Read only: Session Keeper owns these. */
    'session-keeper': {
      /** True while Session Keeper's panel shows the Auto Model row. */
      hosting: boolean
      /** The fast mode and Ultracode choices made on Session Keeper's panel. */
      amModes: AmModes | null
    }
  }
}
