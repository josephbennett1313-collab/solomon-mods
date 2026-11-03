# Limit Guard

Stops runaway helpers, huge prompts and retry loops before they burn your plan limits.

Part of [Solomon Mods](https://github.com/josephbennett1313-collab/solomon-mods), a free set of Claude Code mods by Joseph Bennett.

## Install

```
/plugin marketplace add josephbennett1313-collab/solomon-mods
/plugin install limit-guard@solomon-mods
```

## Use

Commands: /limits.
It shows above the prompt or acts in the background.
Turn it, or any part of it, on or off from the Mods tab (`/mods`).

## Parts you can switch off

- `helpers`: Cap helpers started in one turn
- `loops`: Stop the same failing command repeating
- `size`: Warn before a huge file is read

## Licence

MIT. See the repository's LICENSE and SOURCES.md.
