export type Touch = { path: string; reads: number; edits: number; last: number }
export type Node = { path: string; name: string; depth: number; dir: boolean; changed: string }
export type Now = { verb: string; path: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'file-tree': {
      touched: Touch[]
      tree: Node[]
      now: Now | null
      root: string
      open: string[]
    }
  }
}
