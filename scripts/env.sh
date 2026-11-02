# For contributors: set these before running scripts/check.sh.
# CLAUDE_BIN: the claude command. TSC: a TypeScript compiler. TYPES: Claude Code's mod API types
# (claude-code.d.ts, written by the plugin-authoring skill when it loads).
export CLAUDE_BIN="${CLAUDE_BIN:-claude}"
export TSC="${TSC:-tsc}"
export TYPES="${TYPES:?Set TYPES to the path of claude-code.d.ts}"
