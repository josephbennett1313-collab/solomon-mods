// Mission Control (Solomon Mods): one place to watch Claude work.
// A red task bar above the prompt that follows the chat's task list, an All Tasks tab with every
// chat's list, the /goal meter, helper cards and a plain-English activity feed. Written for
// Solomon Mods; the ideas it builds on are credited in SOURCES.md.

import type { Register } from 'claude-code'

import { registerDesk } from './desk'
import { registerGoal } from './goal'

export const register: Register = on => {
  registerDesk(on)
  registerGoal(on)
}
