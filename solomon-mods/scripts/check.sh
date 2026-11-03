#!/bin/sh
# Type-checks and validates one mod (or all). Needs CLAUDE_BIN, TSC and TYPES set.
cd "$(dirname "$0")/.." || exit 1
for d in ${1:-mods/*}; do
  d=${d%/}; tmp=$(mktemp -d "${TMPDIR:-/tmp}/chk.XXXX")
  cat > "$tmp/tsconfig.json" <<J
{ "compilerOptions": { "target": "es2023", "lib": ["es2023"], "module": "esnext", "moduleResolution": "bundler",
  "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true, "skipLibCheck": true,
  "jsx": "react", "allowImportingTsExtensions": true, "jsxFactory": "h", "jsxFragmentFactory": "Fragment" },
  "include": ["$TYPES", "$PWD/$d/hooks", "$PWD/$d/types"] }
J
  echo "== $d"; "$TSC" -p "$tmp" | head -30
  "$CLAUDE_BIN" plugin validate "$d" 2>&1 | grep -E "✘|✔|error|Error" | head -10
  rm -rf "$tmp"
done
