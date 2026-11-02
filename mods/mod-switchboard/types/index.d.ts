/** One mod in the pane: a suite mod (from its suite.json) or another mod found on disk. */
export type Row = {
  name: string
  title: string
  what: string
  /** Its slash command(s). */
  tip: string
  /** It has a side pane that Open can bring up. */
  pane: boolean
  /** It draws something that Shown/Hidden can hide. */
  hide: boolean
  /** A Solomon Mods mod. */
  suite: boolean
  /** Reads switches.json, so Off works on it. */
  switchable: boolean
  /** Loaded in this chat only (testing). */
  chatOnly: boolean
  parts: { key: string; label: string; byDefault: boolean }[]
  /** Original mods this one takes the place of. */
  replaces: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'mod-switchboard': { note: string; expanded: string[] }
  }
}
