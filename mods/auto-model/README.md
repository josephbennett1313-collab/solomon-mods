# Auto Model

Picks the model and effort for every prompt, runs fast mode and Ultracode on auto, on or off per chat, and compacts first when a switch would re-read a long chat.

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
- `fast`: Fast mode starts on auto in a new chat (turns on by itself for urgent asks); off starts it off
- `ultracode`: Ultracode starts on auto in a new chat (added to big multi-file code jobs; runs many helpers, uses more of your plan); off starts it off
- `compact`: Compact before a switch that would re-read a long chat
- `chip`: Auto Model chip above the prompt (only when Session Keeper's panel is hidden or off)

## Licence

MIT. See the repository's LICENSE and SOURCES.md.
