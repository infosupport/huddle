#!/bin/bash
# UserPromptSubmit hook: writes a lightweight real-time event entry so prompts
# are captured immediately, without waiting until session end.
set -uo pipefail

INPUT=$(cat)

WORKSPACE="${CLAUDE_PROJECT_DIR:-/workspaces/huddle}"
GIT_EMAIL=$(git -C "$WORKSPACE" config user.email 2>/dev/null || echo "unknown@unknown")
GIT_NAME=$(git -C "$WORKSPACE" config user.name 2>/dev/null || echo "unknown")
DATE=$(date +%Y-%m-%d)
YEAR=$(date +%Y)
MONTH=$(date +%m)
SESSION_ID="${CLAUDE_SESSION_ID:-unknown}"
AUDIT_DIR="${WORKSPACE}/.audit/${GIT_EMAIL}/${YEAR}/${MONTH}"

mkdir -p "$AUDIT_DIR"

AUDIT_FILE="${AUDIT_DIR}/${DATE}-${SESSION_ID}-events.jsonl"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

python3 -c "
import json, sys

data = json.loads(sys.argv[1])
entry = {
    'ts': sys.argv[2],
    'user': sys.argv[3],
    'email': sys.argv[4],
    'session': sys.argv[5],
    'event': 'prompt',
    'prompt': data.get('prompt', ''),
}
with open(sys.argv[6], 'a') as f:
    f.write(json.dumps(entry) + '\n')
" "$INPUT" "$TIMESTAMP" "$GIT_NAME" "$GIT_EMAIL" "$SESSION_ID" "$AUDIT_FILE"

git -C "$WORKSPACE" add "$AUDIT_FILE"
