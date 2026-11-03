export type Score = { key: string; label: string; score: number }
export type Fix = { title: string; detail: string; group: string }
export type Report = {
  url: string
  phase: 'running' | 'done' | 'failed'
  device: 'mobile' | 'desktop'
  scores: Score[]
  fixes: Fix[]
  note: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'site-check': {
      report: Report | null
    }
  }
}
