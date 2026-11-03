"""Prints two words: the prompt-cache TTL this chat's main thread writes with (1h, 5m or unknown),
and when its last main-thread reply ended, in ms since 1970 (0 when unknown). A resumed chat
has no reply in this run yet, so the second word is how Session Keeper knows its cache is cold."""
import glob, json, os, sys
from datetime import datetime

sid = sys.argv[1] if len(sys.argv) > 1 else ''
paths = glob.glob(os.path.expanduser(f'~/.claude/projects/*/{sid}.jsonl')) if sid else []
if not paths:
    print('unknown 0'); sys.exit(0)
with open(paths[0], 'rb') as f:
    f.seek(0, 2)
    f.seek(max(0, f.tell() - 3_000_000))
    tail = f.read().decode('utf-8', 'ignore').splitlines()[1:]


def ms(stamp):
    try:
        return int(datetime.fromisoformat(str(stamp).replace('Z', '+00:00')).timestamp() * 1000)
    except Exception:
        return 0


ttl, last = 'unknown', 0
for line in reversed(tail):
    try:
        j = json.loads(line)
    except Exception:
        continue
    if j.get('type') != 'assistant' or j.get('isSidechain'):
        continue
    if not last:
        last = ms(j.get('timestamp'))
    cc = ((j.get('message') or {}).get('usage') or {}).get('cache_creation') or {}
    if (cc.get('ephemeral_1h_input_tokens') or 0) > 0:
        ttl = '1h'
    elif (cc.get('ephemeral_5m_input_tokens') or 0) > 0:
        ttl = '5m'
    if ttl != 'unknown' and last:
        break
print(ttl, last)
