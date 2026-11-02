export type Idea = { line: number; text: string; date: string }

declare module 'claude-code' {
  interface PluginState {
    'idea-shelf': {
      ideas: Idea[]
      file: string
      note: string
    }
  }
}
