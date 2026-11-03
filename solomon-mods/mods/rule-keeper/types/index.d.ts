export type Band = {
  /** offer: Save this as a rule? saved: a short confirmation. */
  phase: 'offer' | 'saved'
  id: number
  rule: string
  slug: string
  correction: string
  path: string
  shortPath: string
  note: string
}

export type Pin = { id: number; text: string; checked: boolean | null; rule: boolean }
export type Pins = { nextId: number; items: Pin[] }

declare module 'claude-code' {
  interface PluginState {
    'rule-keeper': { band: Band | null; pins: Pins | null }
  }
}
