# Solomon Mods

20 free mods for Claude Code, made by Joseph Bennett. They add panels, bars and safety checks to Claude Code so you can see what it is doing, what it costs, and stop it before it makes a mess.

## Install

In Claude Code, add this collection once:

```
/plugin marketplace add josephbennett1313-collab/solomon-mods
```

Then install the mods you want, one line each:

```
/plugin install session-keeper@solomon-mods
/plugin install mission-control@solomon-mods
/plugin install helper-desk@solomon-mods
/plugin install collision-guard@solomon-mods
/plugin install prompt-forge@solomon-mods
/plugin install rule-keeper@solomon-mods
/plugin install session-ledger@solomon-mods
/plugin install mod-switchboard@solomon-mods
/plugin install higgs-content@solomon-mods
/plugin install auto-model@solomon-mods
/plugin install file-tree@solomon-mods
/plugin install design-picker@solomon-mods
/plugin install idea-shelf@solomon-mods
/plugin install edit-rewind@solomon-mods
/plugin install privacy-shield@solomon-mods
/plugin install assumption-radar@solomon-mods
/plugin install command-guard@solomon-mods
/plugin install limit-guard@solomon-mods
/plugin install voice-guard@solomon-mods
/plugin install site-check@solomon-mods
```

Start with **Mod Switchboard** (`/mods`): it gives every mod, and every part of each mod, an on/off switch.

## The mods

| # | Mod | What it does | Commands |
|---|-----|--------------|----------|
| 1 | **Session Keeper** | A cache bar above the prompt with rewrite and session cost, a smart next-command button, a hold on cold-cache messages, and a device-aware handoff | /keeper · /handoff · /keepwarm |
| 2 | **Mission Control** | A red goal bar that tracks the real task list, /goal, and an All Tasks view across every open chat | /mission · /alltasks (and Claude Code's /goal) |
| 3 | **Helper Desk** | A Helper Desk tab with a fox card per helper agent, chat cost, helper tokens and time, a saved to-do list, and a team-size dock | /helpers · /team |
| 4 | **Collision Guard** | Stops two open chats editing the same file: proceed, move to a worktree, or cancel | /collisions |
| 5 | **Prompt Forge** | Turns a long brain dump into a clear brief in Anthropic's recommended shape, asks the questions that matter first, and queues next prompts with /after | /forge · /after · /shape · /coach |
| 6 | **Rule Keeper** | Spots lasting rules you give Claude and saves the ones you approve to your Obsidian vault, plus pins above the prompt | /pin · /reflect |
| 7 | **Session Ledger** | In this chat (to-dos, connectors, skills, files, repos, vault folders) and a Today / Week / Month / Year report at your hourly rate | /ledger · /report |
| 8 | **Mod Switchboard** | One Mods tab with an on/off switch for every mod and every part of a mod | /mods |
| 9 | **Higgs Content** | A photo and video studio on the Higgsfield connector: describe, review the upgraded prompt and credit cost, create, and browse the gallery | /create |
| 10 | **Auto Model** | Picks the model, effort, Fast mode and ultracode for every prompt, and compacts first when a switch would re-read a long chat | /automodel |
| 11 | **File Tree** | A Files tab showing what Claude is reading or editing right now, every file it touched, and the folder tree with changes highlighted | /files |
| 12 | **Design Picker** | Opens by itself on design questions: live mockup cards built with design skills, with motion, and a Send to Figma step | /styles |
| 13 | **Idea Shelf** | Park side ideas per project in your Obsidian vault without breaking Claude's focus, then send or drop each one | /shelf · /idea |
| 14 | **Edit Rewind** | Step through a turn's edits, undo a turn, and restore from a snapshot timeline | /rewind-edits · /tm |
| 15 | **Privacy Shield** | Masks names, emails, phones and amounts while you share your screen, keeps keys out of what Claude reads, and blocks .env and SSH key files | /screen-share |
| 16 | **Assumption Radar** | Lists decisions Claude made without asking so you can mark each right or wrong | /assumptions |
| 17 | **Command Guard** | Holds risky shell commands (delete everything, force push, hard reset) until you press Proceed | /guard |
| 18 | **Limit Guard** | Stops runaway helpers, huge prompts and retry loops before they burn your plan limits | /limits |
| 19 | **Voice Guard** | Flags AI-sounding phrases in posts and emails Claude writes, before they go out | /voiceguard |
| 20 | **Site Check** | /sitecheck scores a website's speed, SEO and accessibility with Lighthouse and explains the fixes | /sitecheck |

Also worth knowing: Claude Code now has a built-in **"You should know"** tip, so it is not a separate mod here.

## Settings

Some mods read `~/.claude/mods/settings.json`. All keys are optional:

```json
{
  "vault": "~/path/to/your/Obsidian vault",
  "higgsfield": "claude.ai Higgsfield"
}
```

- `vault`: where Rule Keeper, Idea Shelf and Session Ledger save to and read from.
- `higgsfield`: the name of your Higgsfield connector, if it is not the usual one.

## Good to know

- Nothing here sends your data anywhere new. Mods read and write files under `~/.claude/` and call the connectors you already have.
- Higgs Content only spends credits after you press Create, and it shows the cost first.
- Auto Model's ultracode part is off until you turn it on, because it runs many helpers at once.
- Numbers in Session Ledger's report are estimates of a person's time, not a bill.

## Licence

MIT, see [LICENSE](LICENSE). Ideas and credits: [SOURCES.md](SOURCES.md).
