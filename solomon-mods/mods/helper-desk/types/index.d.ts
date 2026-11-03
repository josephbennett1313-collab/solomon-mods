export type Helper = {
  id: string
  /** A clear title: the task's own description, tidied. */
  title: string
  type: string
  color: string
  status: string
  startedAt: number
  endedAt: number
  tokens: number
  ms: number
  model: string
}

export type Todo = { id: string; text: string; done: boolean; at: number }

export type Dock = { size: number; model: string }

declare module 'claude-code' {
  interface PluginState {
    'helper-desk': {
      helpers: Helper[]
      todos: Todo[]
      dock: Dock
      note: string
      usd: number
    }
  }
}
