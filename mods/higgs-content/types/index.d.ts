export type Kind = 'photo' | 'video'

export type Draft = {
  kind: Kind
  idea: string
  prompt: string
  aspect: string
  model: string
  phase: 'idle' | 'upgrading' | 'quoting' | 'ready' | 'creating' | 'failed'
  credits: string
  note: string
}

export type Shot = { id: string; kind: Kind; prompt: string; urls: string[]; status: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'higgs-content': {
      draft: Draft
      gallery: Shot[]
      balance: string
    }
  }
}
