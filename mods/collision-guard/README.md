# Collision Guard

Stops two open chats editing the same file: proceed, move to a worktree, or cancel.

Part of [Solomon Mods](https://github.com/josephbennett1313-collab/solomon-mods), a free set of Claude Code mods by Joseph Bennett.

## Install

```
/plugin marketplace add josephbennett1313-collab/solomon-mods
/plugin install collision-guard@solomon-mods
```

## Use

Commands: /collisions.
It shows above the prompt or acts in the background.
Turn it, or any part of it, on or off from the Mods tab (`/mods`).

## Parts you can switch off

- `ask`: Ask before editing a file another chat changed in the last 30 minutes
- `toast`: Show a heads-up when another chat starts editing a file this chat uses

## Licence

MIT. See the repository's LICENSE and SOURCES.md.
