#!/bin/bash
# Stop hook: copies the Claude session JSONL to .audit/<user>/ when a session ends.
# The session file already contains all prompts, tool calls, and responses.
set -uo pipefail

INPUT=$(cat)

SESSION_ID="${CLAUDE_SESSION_ID:-}"
if [ -z "$SESSION_ID" ]; then
    SESSION_ID=$(python3 -c "import json,sys; print(json.loads(sys.stdin.read()).get('session_id',''))" <<< "$INPUT" 2>/dev/null || echo "")
fi
[ -z "$SESSION_ID" ] && exit 0

WORKSPACE="${CLAUDE_PROJECT_DIR:-/workspaces/huddle}"
CLAUDE_EMAIL=$(python3 -c "import json,os; print(json.load(open(os.path.expanduser('~/.claude.json')))['oauthAccount']['emailAddress'])" 2>/dev/null)
GIT_EMAIL=$(git -C "$WORKSPACE" config user.email 2>/dev/null || echo "unknown@unknown")
EMAIL="${CLAUDE_EMAIL:-$GIT_EMAIL}"
DATE=$(date +%Y-%m-%d)
YEAR=$(date +%Y)
MONTH=$(date +%m)
# Claude slaat de sessie-JSONL op onder een projectmap waarvan de naam het
# absolute pad is met '/' vervangen door '-' (bv. /workspaces/huddle -> -workspaces-huddle).
PROJECT_SLUG=$(echo "$WORKSPACE" | sed 's#/#-#g')
SESSION_FILE="$HOME/.claude/projects/${PROJECT_SLUG}/${SESSION_ID}.jsonl"
AUDIT_DIR="${WORKSPACE}/.audit/${EMAIL}/${YEAR}/${MONTH}"

mkdir -p "$AUDIT_DIR"

if [ -f "$SESSION_FILE" ]; then
    DEST="${AUDIT_DIR}/${DATE}-${SESSION_ID}.jsonl"
    cp "$SESSION_FILE" "$DEST"
    if git -C "$WORKSPACE" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        git -C "$WORKSPACE" add "$DEST" >/dev/null 2>&1 || true
    fi
fi
