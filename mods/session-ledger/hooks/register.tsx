// Chat Ledger (Solomon Mods): what this chat used, and what all of Claude's work is worth.
// "This chat": the to-do list, connectors and their calls, files and skills (Ben AI's Chat Inventory).
// "Today's Report": tasks done, hours saved and dollar value by day, week and month (Tristen O'Brien's idea).

import type { Register } from 'claude-code'

import { registerInventory, settings } from './inventory'

export const register: Register = (on, options) => {
  const rate = Number((options as { hourlyRate?: unknown }).hourlyRate)
  settings.rate = Number.isFinite(rate) && rate > 0 ? rate : 50
  registerInventory(on)
}
