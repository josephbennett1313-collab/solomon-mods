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

declare module 'claude-code' {
  interface PluginState {
    'auto-model': {
      pick: Pick | null
    }
  }
}
