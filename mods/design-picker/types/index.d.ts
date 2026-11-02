export type Motion = 'none' | 'subtle' | '3d'

export type View = { query: string; ids: string[]; page: number; picked: string; motion?: Motion }

declare module 'claude-code' {
  interface PluginState {
    'design-picker': { view: View }
  }
}
