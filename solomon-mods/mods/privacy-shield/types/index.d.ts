declare module 'claude-code' {
  interface PluginState {
    'privacy-shield': { on: boolean; hidden: number }
  }
}
export type HiddenCount = number
