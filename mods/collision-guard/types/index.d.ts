export type Clash = { path: string; other: string; mins: number; at: number }

declare module 'claude-code' {
  interface PluginState {
    'collision-guard': {
      clashes: Clash[]
      note: string
    }
  }
}
