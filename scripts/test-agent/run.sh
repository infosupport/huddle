#!/usr/bin/env bash
# Local mirror of the "Test agent" GitHub Actions job (docs/test-agent-local-plan.md,
# Huddle PDF part 2, "Running the test agent").
#
# Builds a throwaway Huddle from this checkout, creates a target devcontainer through
# it, then lets Claude Code attack it from outside (Playwright on the portal) and from
# inside (docker exec into the target). Output lands in a fresh folder, nothing is posted.
#
# RUN THIS ONLY IN THE DISPOSABLE LINUX VM. It gives the throwaway Huddle the VM's Docker
# socket and gives an LLM agent a browser and a shell in a container.
#
# Usage:   ANTHROPIC_API_KEY=... scripts/test-agent/run.sh [--keep]
#          CLAUDE_CODE_OAUTH_TOKEN=... scripts/test-agent/run.sh [--keep]
#          scripts/test-agent/run.sh --clean      # remove leftovers of an earlier run
#
# Environment:
#   ANTHROPIC_API_KEY           credential, option 1: a dedicated, spend-limited API key
#   CLAUDE_CODE_OAUTH_TOKEN     credential, option 2: token from `claude setup-token`, created
#                               on your host and pasted into the VM (never log in on the VM).
#                               One of the two is required. Enter it without shell history:
#                                 read -rs CLAUDE_CODE_OAUTH_TOKEN && export CLAUDE_CODE_OAUTH_TOKEN
#   PLAYWRIGHT_MCP_VERSION      default: latest from npm (printed; pin it once it works)
#   TEST_AGENT_OUT              output folder (default ~/test-agent-out/<timestamp>)
#   TEST_AGENT_MAX_TURNS        default 60
#   TEST_AGENT_TIMEOUT_MIN      default 45
#   TEST_AGENT_BUILD_BASE=1     build base-devimage* from this checkout instead of pulling
#   TEST_AGENT_ALLOW_BARE_METAL=1  skip the "am I in a VM" check (not recommended)
#
# Exit code: 0 no failures, 1 at least one area failed, 2 no report was produced.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${TEST_AGENT_OUT:-$HOME/test-agent-out/$RUN_ID}"
MAX_TURNS="${TEST_AGENT_MAX_TURNS:-60}"
TIMEOUT_MIN="${TEST_AGENT_TIMEOUT_MIN:-45}"
HUDDLE_URL="http://localhost:3000"
TARGET="target-dc"
BASE_IMAGE="ghcr.io/infosupport/base-devimage"
IDE_IMAGE="ghcr.io/infosupport/base-devimage-vscode"
KEEP=0
CREATED=0

log()  { printf '\033[36m[test-agent]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[test-agent]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m[test-agent]\033[0m %s\n' "$*" >&2; exit 1; }

remove_resources() {
  docker rm -f "$TARGET" huddle >/dev/null 2>&1 || true
  docker network rm devcontainer-net >/dev/null 2>&1 || true
  docker volume rm huddle-data >/dev/null 2>&1 || true
  rm -rf /tmp/dc-sockets 2>/dev/null || true
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [ "$CREATED" = 1 ]; then
    # Huddle's log holds the proxy/network log of the run (the PDF attaches it to the PR).
    docker logs huddle >"$OUT_DIR/huddle.log" 2>&1 || true
    if [ "$KEEP" = 1 ]; then
      log "kept the Huddle stack for inspection (--keep). Remove it with: $0 --clean"
    else
      log "removing the throwaway Huddle stack"
      remove_resources
    fi
  fi
  exit "$rc"
}

for arg in "$@"; do
  case "$arg" in
    --keep)  KEEP=1 ;;
    --clean) log "removing leftovers of an earlier run"; remove_resources; exit 0 ;;
    *)       die "unknown argument: $arg" ;;
  esac
done

# ── Preflight ───────────────────────────────────────────────────────────────
[ "$(uname -s)" = Linux ] || die "this must run on the Linux VM (found $(uname -s))"
if ! systemd-detect-virt --vm --quiet 2>/dev/null; then
  [ "${TEST_AGENT_ALLOW_BARE_METAL:-}" = 1 ] \
    || die "this does not look like a virtual machine. Run it in the disposable VM, or set TEST_AGENT_ALLOW_BARE_METAL=1 if you know what you are doing."
fi
for cmd in docker node npm npx openssl curl claude timeout; do
  command -v "$cmd" >/dev/null || die "missing command: $cmd"
done
docker info >/dev/null 2>&1 || die "cannot talk to Docker (is your user in the docker group?)"
[ -n "${ANTHROPIC_API_KEY:-}" ] || [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] \
  || die "set ANTHROPIC_API_KEY (a dedicated, spend-limited key) or CLAUDE_CODE_OAUTH_TOKEN (from 'claude setup-token' on your host)"
if docker inspect huddle >/dev/null 2>&1 || docker inspect "$TARGET" >/dev/null 2>&1 \
   || docker network inspect devcontainer-net >/dev/null 2>&1; then
  die "a 'huddle' or '$TARGET' container or the 'devcontainer-net' network already exists. Run: $0 --clean"
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
log "output folder: $OUT_DIR"

PLAYWRIGHT_MCP_VERSION="${PLAYWRIGHT_MCP_VERSION:-$(npm view @playwright/mcp version 2>/dev/null || true)}"
[ -n "$PLAYWRIGHT_MCP_VERSION" ] || die "could not determine the @playwright/mcp version; set PLAYWRIGHT_MCP_VERSION"
log "using @playwright/mcp@$PLAYWRIGHT_MCP_VERSION (pin it with PLAYWRIGHT_MCP_VERSION once it works)"

trap cleanup EXIT INT TERM
CREATED=1

# ── Build (same as the CI e2e job) ──────────────────────────────────────────
ensure_image() { # <image> <dockerfile relative to the repo>
  local img="$1" dockerfile="$2"
  if [ "${TEST_AGENT_BUILD_BASE:-0}" != 1 ] && docker pull -q "$img:latest" >/dev/null 2>&1; then
    log "pulled $img"
    return
  fi
  log "building $img from this checkout (pull skipped or failed)"
  docker build -q -t "$img:latest" -f "$REPO_DIR/$dockerfile" "$REPO_DIR" >/dev/null
}

log "building the Huddle gateway image"
docker build -q -t huddle:pr "$REPO_DIR/gateway" >/dev/null
ensure_image "$BASE_IMAGE" base-devimage/Dockerfile
ensure_image "$IDE_IMAGE"  base-devimage-vscode/Dockerfile

# ── Start the throwaway Huddle (same as the CI "Start Huddle" step) ─────────
TOKEN="$(openssl rand -hex 24)"
# Keep the token out of `ps` and out of the agent: a 0600 header file for curl, and a
# browser session file for Playwright. The agent never sees the token itself.
AUTH_HEADER_FILE="$OUT_DIR/.auth-header"
( umask 077; printf 'Authorization: Bearer %s\n' "$TOKEN" >"$AUTH_HEADER_FILE" )
( umask 077; cat >"$OUT_DIR/huddle-session.json" <<EOF
{"cookies":[{"name":"huddle_session","value":"$TOKEN","domain":"localhost","path":"/","expires":-1,"httpOnly":true,"secure":false,"sameSite":"Strict"}],"origins":[]}
EOF
)

log "starting the throwaway Huddle"
docker network create --internal devcontainer-net >/dev/null
mkdir -p /tmp/dc-sockets
docker run -d \
  --name huddle \
  --network devcontainer-net \
  -p 127.0.0.1:3000:3000 \
  -e HUDDLE_OPERATOR_TOKEN="$TOKEN" \
  -v huddle-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /tmp/dc-sockets:/tmp/dc-sockets \
  huddle:pr >/dev/null
docker network connect bridge huddle

ready=0
for _ in $(seq 1 40); do
  if curl -sf -H "@$AUTH_HEADER_FILE" "$HUDDLE_URL/api/rules" >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || die "Huddle did not become ready on $HUDDLE_URL (see: docker logs huddle)"

# ── Create the target devcontainer through Huddle ───────────────────────────
log "creating the target devcontainer ($TARGET)"
curl -sS --fail-with-body -X POST "$HUDDLE_URL/api/docker/start" \
  -H "@$AUTH_HEADER_FILE" -H 'content-type: application/json' \
  -d "{\"imageName\":\"$IDE_IMAGE\",\"containerName\":\"$TARGET\",\"ideName\":\"vscode\",\"empty\":true}" >/dev/null

deadline=$((SECONDS + 90))
until [ "$(docker inspect -f '{{.State.Running}}' "$TARGET" 2>/dev/null || true)" = true ] \
   && docker exec "$TARGET" sh -lc 'command -v curl >/dev/null && command -v docker >/dev/null' >/dev/null 2>&1; do
  (( SECONDS < deadline )) || die "$TARGET did not come up within 90 seconds"
  sleep 2
done
sleep 4 # the detached post-start config (iptables, proxy, curlrc) needs a moment

# ── Run the agent ───────────────────────────────────────────────────────────
sed "s|{{REPO_DIR}}|$REPO_DIR|g" "$REPO_DIR/.github/agent/test-agent.md" >"$OUT_DIR/prompt.md"
sed "s|{{PLAYWRIGHT_MCP_VERSION}}|$PLAYWRIGHT_MCP_VERSION|g" "$REPO_DIR/.github/agent/playwright-mcp.json" >"$OUT_DIR/playwright-mcp.json"

log "running the agent (max $MAX_TURNS turns, $TIMEOUT_MIN min timeout). Transcript: $OUT_DIR/agent.log"
cd "$OUT_DIR"
set +e
timeout "${TIMEOUT_MIN}m" claude -p "$(cat prompt.md)" \
  --max-turns "$MAX_TURNS" \
  --strict-mcp-config \
  --mcp-config playwright-mcp.json \
  --allowedTools "mcp__playwright__*,Bash(docker exec target-dc:*),Bash(docker exec -u root target-dc:*),Read,Write" \
  --disallowedTools "Read(//proc/**)" \
  2>&1 | tee agent.log
agent_rc=${PIPESTATUS[0]}
set -e
[ "$agent_rc" = 0 ] || warn "the agent exited with status $agent_rc"

# Session secrets are no longer needed.
rm -f "$AUTH_HEADER_FILE" "$OUT_DIR/huddle-session.json"

# ── Result ──────────────────────────────────────────────────────────────────
if [ ! -s report.md ]; then
  warn "the agent wrote no report.md"
  exit 2
fi
echo
log "report ($OUT_DIR/report.md):"
cat report.md
[ -f findings.md ] && warn "findings.md was written: details of failed or unclear security checks are in $OUT_DIR/findings.md"
if grep -Eqi ': FAIL|failed' report.md; then exit 1; fi
grep -qi 'UNCLEAR' report.md && warn "at least one area is UNCLEAR; read $OUT_DIR/evidence.md"
exit 0
