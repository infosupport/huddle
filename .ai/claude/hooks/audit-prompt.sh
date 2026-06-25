#!/bin/bash
# UserPromptSubmit hook: writes a lightweight real-time event entry so prompts
# are captured immediately, without waiting until session end.
set -uo pipefail

INPUT=$(cat)

WORKSPACE="${CLAUDE_PROJECT_DIR:-/workspaces/huddle}"
CLAUDE_EMAIL=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['oauthAccount']['emailAddress'])" 2>/dev/null)
GIT_EMAIL=$(git -C "$WORKSPACE" config user.email 2>/dev/null || echo "unknown@unknown")
EMAIL="${CLAUDE_EMAIL:-$GIT_EMAIL}"
EMAIL="${EMAIL//[^a-zA-Z0-9@._-]/}"
GIT_NAME=$(git -C "$WORKSPACE" config user.name 2>/dev/null || echo "unknown")
DATE=$(date +%Y-%m-%d)
YEAR=$(date +%Y)
MONTH=$(date +%m)
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
SESSION_ID="${SESSION_ID//[^a-zA-Z0-9_-]/}"
AUDIT_DIR="${WORKSPACE}/.audit/${EMAIL}/${YEAR}/${MONTH}"

mkdir -p "$AUDIT_DIR"

AUDIT_FILE="${AUDIT_DIR}/${DATE}-${SESSION_ID}-events.jsonl"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

python3 -c "
import json, sys

data = json.loads(sys.stdin.read())
entry = {
    'ts': sys.argv[1],
    'user': sys.argv[2],
    'email': sys.argv[3],
    'session': sys.argv[4],
    'event': 'prompt',
    'prompt': data.get('prompt', ''),
}
with open(sys.argv[5], 'a') as f:
    f.write(json.dumps(entry) + '\n')
" "$TIMESTAMP" "$GIT_NAME" "$EMAIL" "$SESSION_ID" "$AUDIT_FILE" <<< "$INPUT"

if git -C "$WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$WORKSPACE" add "$AUDIT_FILE" >/dev/null 2>&1 || true
fi
