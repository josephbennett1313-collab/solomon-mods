#!/bin/sh
# Copies shared/suite.ts into every mod's hooks folder (a mod may only import its own files).
cd "$(dirname "$0")/.." || exit 1
for d in mods/*/; do cp shared/suite.ts "$d/hooks/suite.ts"; done
echo "synced $(ls -d mods/*/ | wc -l | tr -d ' ') mods"
