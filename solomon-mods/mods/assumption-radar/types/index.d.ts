export type Level = 'undo' | 'know'
export type Decision = { id: number; time: string; level: Level; area: string; decision: string; reason: string; alternative: string }
export type Mark = 'open' | 'right' | 'wrong'
export type Assumption = { id: number; text: string; why: string; mark: Mark }

declare module 'claude-code' {
  interface PluginState {
    'assumption-radar': { pending: Decision[]; assumptions: Assumption[]; notice: boolean }
  }
}
