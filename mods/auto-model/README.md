# Auto Model

Picks the model, effort, Fast mode and ultracode for every prompt, and compacts first when a switch would re-read a long chat.

Part of [Solomon Mods](https://github.com/josephbennett1313-collab/solomon-mods), a free set of Claude Code mods by Joseph Bennett.

## Install

```
/plugin marketplace add josephbennett1313-collab/solomon-mods
/plugin install auto-model@solomon-mods
```

## Use

Commands: /automodel.
It shows above the prompt or acts in the background.
Turn it, or any part of it, on or off from the Mods tab (`/mods`).

## Parts you can switch off

- `model`: Pick the model for each prompt
- `effort`: Pick the effort for each prompt
- `fast`: Turn on Fast mode when speed matters
- `ultracode`: Add ultracode to big multi-file code jobs (runs many helpers, uses more of your plan)
- `compact`: Compact before a switch that would re-read a long chat
- `chip`: Model chip above the prompt

## Licence

MIT. See the repository's LICENSE and SOURCES.md.
