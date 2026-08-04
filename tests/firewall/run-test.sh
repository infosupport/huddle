#!/usr/bin/env bash
#
# Huddle firewall compatibility test — runtime-agnostic (Linux & macOS).
#
# One test, driven by GitHub Actions across the OS × runtime matrix. The
# workflow only picks the platform and the runtime; ALL of the actual test
# logic lives here (and in the PowerShell sibling run-test.ps1) so the exact
# same scenario runs locally and in CI.
#
# Milestone 1 — firewall basics:
#   1. Activate the requested container runtime (docker or podman).
#   2. Install/start Huddle via its own CLI (the real `huddle init` path).
#   3. Start a minimal test devcontainer on Huddle's internal network.
#   4. Assert an allowed URL is reachable.
#   5. Assert a blocked URL is not reachable.
#   6. (optional) Path mode: an allowed path works, a sibling path is blocked.
#   7. Collect the Huddle logs.
#   8. Always clean up — containers, network, test client — even on failure.
#
# Usage:
#   tests/firewall/run-test.sh --runtime <docker|podman>
#   HUDDLE_RUNTIME=podman tests/firewall/run-test.sh
#
# Exit code: 0 when every required assertion passed, 1 otherwise.

set -uo pipefail

# ── Locations ────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CONFIG_DIR="$SCRIPT_DIR/huddle-test-config"
LOG_DIR="${HUDDLE_TEST_LOG_DIR:-$SCRIPT_DIR/.logs}"

# ── Output helpers ────────────────────────────────────────────────────────────
if [ -t 1 ] && [ "${NO_COLOR:-}" != "1" ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_YEL=$'\033[33m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_RED=; C_GRN=; C_YEL=; C_DIM=; C_RST=
fi
log()  { printf '%s\n' "${C_DIM}• $*${C_RST}"; }
step() { printf '\n%s\n' "==> $*"; }
pass() { printf '%s\n' "${C_GRN}  PASS${C_RST} $*"; }
warn() { printf '%s\n' "${C_YEL}  WARN${C_RST} $*"; }
fatal() { printf '%s\n' "${C_RED}FATAL${C_RST} $*" >&2; exit 1; }

FAILURES=0
fail() { printf '%s\n' "${C_RED}  FAIL${C_RST} $*" >&2; FAILURES=$((FAILURES + 1)); }

# ── Parse args / config ──────────────────────────────────────────────────────
RUNTIME="${HUDDLE_RUNTIME:-}"
RUN_PATHMODE="${HUDDLE_TEST_PATHMODE:-auto}"
while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) RUNTIME="${2:-}"; shift 2 ;;
    --runtime=*) RUNTIME="${1#*=}"; shift ;;
    --no-pathmode) RUN_PATHMODE=0; shift ;;
    --pathmode) RUN_PATHMODE=1; shift ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) fatal "unknown argument: $1" ;;
  esac
done
[ -n "$RUNTIME" ] || fatal "no runtime given — pass --runtime <docker|podman> or set HUDDLE_RUNTIME"
case "$RUNTIME" in docker|podman) ;; *) fatal "unsupported runtime '$RUNTIME' (docker|podman)";; esac

# Load the shared test cases; already-exported vars win over the file defaults.
[ -f "$CONFIG_DIR/cases.env" ] || fatal "missing config: $CONFIG_DIR/cases.env"
while IFS='=' read -r key value; do
  case "$key" in ''|\#*) continue ;; esac
  key="${key%% *}"
  # Honour an existing environment override; otherwise take the file value.
  if [ -z "${!key:-}" ]; then export "$key=$value"; fi
done < "$CONFIG_DIR/cases.env"

RT="$RUNTIME"
HUDDLE_URL="${HUDDLE_URL:-http://localhost:3000}"
CLIENT="$HUDDLE_TEST_CLIENT_NAME"
CLIENT_IMAGE="$HUDDLE_TEST_CLIENT_IMAGE"
# Huddle's own fixed resource names (see cli/src/init.ts).
HUDDLE_CONTAINER=huddle
HUDDLE_NETWORK=devcontainer-net

# Operator token for the management API — reused by the CLI and our curl calls.
if [ -z "${HUDDLE_OPERATOR_TOKEN:-}" ]; then
  HUDDLE_OPERATOR_TOKEN="$(openssl rand -hex 24 2>/dev/null || head -c24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
export HUDDLE_OPERATOR_TOKEN HUDDLE_RUNTIME="$RT"

# ── Cleanup (always runs) ─────────────────────────────────────────────────────
cleanup() {
  local code=$?
  step "Collecting logs & cleaning up"
  mkdir -p "$LOG_DIR"
  "$RT" logs "$HUDDLE_CONTAINER" >"$LOG_DIR/huddle-$RT.log" 2>&1 && log "Huddle logs -> $LOG_DIR/huddle-$RT.log" || warn "could not collect Huddle logs"
  "$RT" logs "$CLIENT" >"$LOG_DIR/client-$RT.log" 2>&1 || true
  "$RT" rm -f "$CLIENT"          >/dev/null 2>&1 || true
  "$RT" rm -f "$HUDDLE_CONTAINER" >/dev/null 2>&1 || true
  "$RT" network rm "$HUDDLE_NETWORK" >/dev/null 2>&1 || true
  log "cleanup done"
  # Preserve an earlier fatal exit; otherwise reflect the assertion tally.
  [ "$code" -ne 0 ] && exit "$code"
  exit "$(( FAILURES > 0 ? 1 : 0 ))"
}
trap cleanup EXIT INT TERM

# ── Management API (host -> :3000, operator-authenticated) ────────────────────
api() { # api METHOD PATH [JSON_BODY]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sf -X "$method" -H "Authorization: Bearer $HUDDLE_OPERATOR_TOKEN" \
      -H 'Content-Type: application/json' -d "$body" "$HUDDLE_URL$path"
  else
    curl -sf -X "$method" -H "Authorization: Bearer $HUDDLE_OPERATOR_TOKEN" "$HUDDLE_URL$path"
  fi
}

# curl from INSIDE the test devcontainer; prints only the HTTP status
# ("000" when the connection/CONNECT is refused).
client_code() { # client_code URL [extra curl args...]
  local url="$1"; shift || true
  "$RT" exec "$CLIENT" sh -c \
    "curl -s -o /dev/null -w '%{http_code}' $* '$url' || true" 2>/dev/null | tr -d '\r'
}

# ── 1. Activate runtime ───────────────────────────────────────────────────────
step "1. Container runtime: $RT"
command -v "$RT" >/dev/null 2>&1 || fatal "'$RT' is not on PATH"
"$RT" info >/dev/null 2>&1 || fatal "'$RT' daemon/machine is not reachable"
log "$("$RT" version --format '{{.Server.Version}}' 2>/dev/null || "$RT" --version)"

# ── 2. Install / start Huddle ─────────────────────────────────────────────────
step "2. Build & start Huddle"

# Resolve the CLI: an installed `huddle`, an already-built dist, else build it.
if command -v huddle >/dev/null 2>&1; then
  huddle_cli() { huddle "$@"; }
  log "using 'huddle' from PATH"
else
  if [ ! -f "$REPO_ROOT/cli/dist/index.js" ]; then
    log "building the CLI"
    (cd "$REPO_ROOT/cli" && npm ci --silent && npm run build --silent) || fatal "CLI build failed"
  fi
  huddle_cli() { node "$REPO_ROOT/cli/dist/index.js" "$@"; }
  log "using node $REPO_ROOT/cli/dist/index.js"
fi

# Build the gateway image locally and tell init to use it (no registry pull).
IMAGE="${HUDDLE_IMAGE:-huddle:citest}"
if [ -z "${HUDDLE_IMAGE:-}" ]; then
  log "building gateway image $IMAGE"
  "$RT" build "$REPO_ROOT/gateway" -t "$IMAGE" || fatal "gateway build failed"
fi
export HUDDLE_IMAGE="$IMAGE" HUDDLE_NO_PULL=1

log "huddle init (runtime=$RT)"
huddle_cli init --runtime "$RT" || fatal "huddle init failed"

# Wait for the management API to answer with our operator token.
log "waiting for the management API at $HUDDLE_URL"
ready=0
for _ in $(seq 1 30); do
  if api GET /api/rules >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || fatal "Huddle API did not become ready"
pass "Huddle is up"

# ── 3. Minimal test devcontainer ──────────────────────────────────────────────
step "3. Start the minimal test devcontainer"
"$RT" pull "$CLIENT_IMAGE" >/dev/null 2>&1 || fatal "could not pull $CLIENT_IMAGE"
"$RT" rm -f "$CLIENT" >/dev/null 2>&1 || true
# Attached ONLY to Huddle's --internal network: its sole route out is the proxy.
# Proxy env mirrors what `huddle migrate` injects into real devcontainers.
"$RT" run -d --name "$CLIENT" --network "$HUDDLE_NETWORK" \
  -e HTTP_PROXY=http://huddle:80 -e HTTPS_PROXY=http://huddle:80 \
  -e http_proxy=http://huddle:80 -e https_proxy=http://huddle:80 \
  -e NO_PROXY=localhost,127.0.0.1,huddle -e no_proxy=localhost,127.0.0.1,huddle \
  --entrypoint sleep "$CLIENT_IMAGE" infinity >/dev/null \
  || fatal "could not start the test client"

# Fetch Huddle's MITM root CA so HTTPS (path mode) can be intercepted. Reached
# directly (huddle is in NO_PROXY), exactly like a real devcontainer does.
"$RT" exec "$CLIENT" sh -c 'curl -s -o /tmp/huddle-ca.crt http://huddle:3000/api/tls/ca.crt' \
  || warn "could not fetch the CA (HTTPS/path-mode checks may be skipped)"
CACERT_OPT="--cacert /tmp/huddle-ca.crt"
pass "test client '$CLIENT' running on $HUDDLE_NETWORK"

# ── 4. Blocked URL is unreachable (default-deny, checked first) ───────────────
step "4. Blocked URL stays blocked"
code="$(client_code "$HUDDLE_TEST_BLOCKED_URL")"
if [ "$code" = "$HUDDLE_TEST_BLOCKED_EXPECT" ]; then
  pass "blocked $HUDDLE_TEST_BLOCKED_URL -> $code"
else
  fail "blocked $HUDDLE_TEST_BLOCKED_URL -> $code (expected $HUDDLE_TEST_BLOCKED_EXPECT)"
fi

# ── 5. Allowed URL becomes reachable after an allow rule ──────────────────────
step "5. Allowed URL is reachable after approval"
huddle_cli firewall add "$HUDDLE_TEST_ALLOWED_DOMAIN" >/dev/null || fail "firewall add failed"
code=""
for _ in 1 2 3 4; do
  code="$(client_code "$HUDDLE_TEST_ALLOWED_URL")"
  [ "$code" = "$HUDDLE_TEST_ALLOWED_EXPECT" ] && break
  sleep 1
done
if [ "$code" = "$HUDDLE_TEST_ALLOWED_EXPECT" ]; then
  pass "allowed $HUDDLE_TEST_ALLOWED_URL -> $code"
else
  fail "allowed $HUDDLE_TEST_ALLOWED_URL -> $code (expected $HUDDLE_TEST_ALLOWED_EXPECT)"
fi

# ── 6. Path mode (optional) ───────────────────────────────────────────────────
if [ "$RUN_PATHMODE" = 0 ]; then
  step "6. Path mode — skipped (--no-pathmode)"
elif ! command -v jq >/dev/null 2>&1; then
  step "6. Path mode — skipped (jq not available)"
else
  step "6. Path mode: allowed path works, sibling path blocked"
  pm_domain="$HUDDLE_TEST_PATHMODE_DOMAIN"
  # Host-level deny marker, switched into path-allowlist mode, plus one allow path.
  rid="$(api POST /api/rules "{\"domain\":\"$pm_domain\",\"container_id\":null,\"status\":\"deny\"}" | jq -r '.id')"
  if [ -n "$rid" ] && [ "$rid" != null ]; then
    api POST "/api/rules/$rid/path-mode" '{"enabled":true}' >/dev/null || warn "enable path-mode failed"
    api POST /api/rules "{\"domain\":\"$pm_domain\",\"container_id\":null,\"status\":\"allow\",\"path_pattern\":\"$HUDDLE_TEST_PATHMODE_PATTERN\"}" >/dev/null || warn "add allow path failed"
    sleep 1
    a="$(client_code "$HUDDLE_TEST_PATHMODE_ALLOWED_URL" "$CACERT_OPT --path-as-is")"
    b="$(client_code "$HUDDLE_TEST_PATHMODE_BLOCKED_URL" "$CACERT_OPT --path-as-is")"
    if [ "$a" != "403" ] && [ "$a" != "000" ]; then
      pass "path-mode allowed $HUDDLE_TEST_PATHMODE_ALLOWED_URL -> $a"
    else
      fail "path-mode allowed $HUDDLE_TEST_PATHMODE_ALLOWED_URL -> $a (expected a forwarded, non-403 status)"
    fi
    if [ "$b" = "403" ]; then
      pass "path-mode blocked $HUDDLE_TEST_PATHMODE_BLOCKED_URL -> $b"
    else
      fail "path-mode blocked $HUDDLE_TEST_PATHMODE_BLOCKED_URL -> $b (expected 403)"
    fi
  else
    warn "could not create the path-mode rule — skipping"
  fi
fi

# ── Report ────────────────────────────────────────────────────────────────────
step "Result"
if [ "$FAILURES" -eq 0 ]; then
  printf '%s\n' "${C_GRN}All firewall checks passed ($RT).${C_RST}"
else
  printf '%s\n' "${C_RED}$FAILURES firewall check(s) failed ($RT).${C_RST}"
fi
# The EXIT trap turns FAILURES into the final exit code after cleanup.
