#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# run-sandbox-mode.sh — run Huddle in Docker Sandbox (sbx) mode via a FILE MAILBOX.
#
# The gateway stays in a container; sbx runs on the host (Windows). We bridge them
# with the simplest possible pipe — a shared folder + two tiny scripts:
#
#   gateway container:  `sbx <args>`  (bridge/sbx.sh, baked in the image)
#        │  writes  <bridge>/req/<id>.req   and waits for  <bridge>/res/<id>.code
#        ▼  (shared folder, bind-mounted — no sockets, no networking)
#   host (this shell):  sbx-watcher.sh  runs the real sbx.exe, writes the response
#
# Works straight from git bash on Windows (no WSL, no socat, no npiperelay).
#
# Usage:
#   ./run-sandbox-mode.sh            # start watcher + build + run gateway + check
#   ./run-sandbox-mode.sh --status   # check the pipe (the real 'sbx status')
#   ./run-sandbox-mode.sh --stop     # stop the host watcher
#   ./run-sandbox-mode.sh --watch-only   # only run the host watcher
#   ./run-sandbox-mode.sh --no-build # skip rebuilds
#
# Env:
#   HUDDLE_RUNTIME=docker|podman     container runtime (default: docker)
#   HUDDLE_SBX_BIN=<sbx|sbx.exe>     real sbx binary on the host (auto-detected)
#   HUDDLE_SBX_BRIDGE_WIN=<path>     shared folder (default: $HOME/.huddle-sbx)
#   HUDDLE_DEV_IMAGE=<ref>           local gateway image tag (default: huddle:sbx-local)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

RT="${HUDDLE_RUNTIME:-docker}"
GATEWAY_IMAGE="${HUDDLE_DEV_IMAGE:-huddle:sbx-local}"
BRIDGE="${HUDDLE_SBX_BRIDGE_WIN:-$HOME/.huddle-sbx}"
STATE_DIR="$ROOT/.huddle-native"
CLI="node cli/dist/index.js"   # the host bridge now lives in the CLI (huddle sbx bridge)

c_blue()  { printf '\033[1;34m%s\033[0m\n' "$*"; }
c_green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
c_warn()  { printf '\033[1;33m%s\033[0m\n' "$*"; }
c_err()   { printf '\033[1;31m%s\033[0m\n' "$*" >&2; }
step()    { echo; c_blue "==> $*"; }

# sbx binary (host side): sbx or sbx.exe.
SBX_BIN="${HUDDLE_SBX_BIN:-}"
if [ -z "$SBX_BIN" ]; then
  if command -v sbx >/dev/null 2>&1; then SBX_BIN=sbx
  elif command -v sbx.exe >/dev/null 2>&1; then SBX_BIN=sbx.exe
  else SBX_BIN=sbx; fi
fi

BUILD=1; DO_STOP=0; DO_STATUS=0; WATCH_ONLY=0
for a in "$@"; do
  case "$a" in
    --no-build)   BUILD=0 ;;
    --stop)       DO_STOP=1 ;;
    --status|--check) DO_STATUS=1 ;;
    --watch-only) WATCH_ONLY=1 ;;
    -h|--help)    sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

mkdir -p "$STATE_DIR" "$BRIDGE/req" "$BRIDGE/res"

ensure_cli() {  # the bridge + status commands need cli/dist
  [ -f cli/dist/index.js ] && return 0
  [ -d cli/node_modules ] || npm --prefix cli install --no-audit --no-fund
  npm --prefix cli run build
}

check_pipe() {
  step "Checking the pipe (this is the real 'sbx status' — no need to type it yourself)"
  ensure_cli
  echo -n "  host bridge : "; $CLI sbx bridge status 2>&1 | sed 's/^/  /' | tail -1
  if command -v "$RT" >/dev/null 2>&1 && "$RT" ps --format '{{.Names}}' 2>/dev/null | grep -qx huddle; then
    # Authoritative test: is the mount point present AND writable from the container?
    # (Create req/res on demand — an empty subdir can lag in Docker Desktop's mount.)
    echo -n "  container sees /sbx-bridge : "
    "$RT" exec huddle sh -c 'mkdir -p /sbx-bridge/req /sbx-bridge/res 2>/dev/null; test -w /sbx-bridge/req' 2>/dev/null \
      && c_green "yes (mounted, writable)" || c_err "NO (folder not mounted)"
  fi
  echo "  gateway → sbx (via mailbox) :"
  HUDDLE_SKIP_CLI_SWITCH=1 $CLI sbx status 2>&1 | sed 's/^/    /' || true
}

if [ "$DO_STOP" = 1 ]; then ensure_cli; $CLI sbx bridge stop; exit 0; fi
if [ "$DO_STATUS" = 1 ]; then check_pipe; exit 0; fi
if [ "$WATCH_ONLY" = 1 ]; then ensure_cli; step "Running the sbx bridge (foreground)"; exec env HUDDLE_SBX_BRIDGE_WIN="$BRIDGE" HUDDLE_SBX_BIN="$SBX_BIN" $CLI sbx bridge run; fi

# ── preflight ────────────────────────────────────────────────────────────────
step "Preflight"
command -v node >/dev/null || { c_err "node not found in PATH"; exit 1; }
command -v npm  >/dev/null || { c_err "npm not found in PATH";  exit 1; }
echo "node $(node -v)  ·  bridge folder $BRIDGE"
if command -v "$SBX_BIN" >/dev/null 2>&1; then
  echo "sbx ($SBX_BIN): $("$SBX_BIN" version 2>/dev/null | head -1 || echo present)"
else
  c_warn "sbx ('$SBX_BIN') not found on PATH — the watcher will run but sbx calls report 'not found'."
  c_warn "Install Docker Sandboxes (https://docs.docker.com/ai/sandboxes/) or set HUDDLE_SBX_BIN."
fi

# ── 1. build gateway image (bakes the container `sbx`) + CLI ─────────────────
# The host bridge (watcher) is auto-started by `huddle init` below via the CLI
# (`huddle sbx bridge`) — no separate watcher process here.
if ! command -v "$RT" >/dev/null 2>&1; then c_err "$RT not found — cannot build/run the gateway. (watcher is up.)"; exit 1; fi
"$RT" info >/dev/null 2>&1 || { c_err "the '$RT' daemon is not reachable"; exit 1; }
cp -f "$ROOT/bridge/sbx.sh" "$ROOT/gateway/sbx.sh"   # keep the baked mailbox client in sync
if [ "$BUILD" = 1 ]; then
  step "Building the gateway image ($GATEWAY_IMAGE) from ./gateway"
  "$RT" build -t "$GATEWAY_IMAGE" ./gateway
  step "Building the CLI"
  [ -d cli/node_modules ] || npm --prefix cli install --no-audit --no-fund
  npm --prefix cli run build
else
  [ -f cli/dist/index.js ] || { npm --prefix cli install --no-audit --no-fund && npm --prefix cli run build; }
fi

# ── 2. huddle init (mounts the bridge folder in + auto-starts the CLI bridge) ─
step "Starting the gateway container (huddle init) — also starts the host bridge"
# HUDDLE_SKIP_CLI_SWITCH keeps the LOCALLY-built CLI in charge (an active experiment
# channel would otherwise reinstall + re-exec the published CLI, dropping this wiring).
HUDDLE_IMAGE="$GATEWAY_IMAGE" HUDDLE_NO_PULL=1 HUDDLE_RUNTIME="$RT" HUDDLE_SKIP_CLI_SWITCH=1 \
HUDDLE_SBX_BRIDGE_WIN="$BRIDGE" \
  node cli/dist/index.js init

# ── 3. self-check ────────────────────────────────────────────────────────────
sleep 1
check_pipe

step "Done"
c_green "Sandbox mode is up (file-mailbox)."
cat <<EOF

  Portal:        http://localhost:3000
  host bridge:   run by the CLI — 'node cli/dist/index.js sbx bridge status'
  bridge folder: $BRIDGE   (mounted → /sbx-bridge in the container)

  Check anytime:   ./run-sandbox-mode.sh --status
  Drive it (local CLI, not the bare 'sbx'):
    node cli/dist/index.js sbx start my-box --workspace "\$PWD"
    node cli/dist/index.js sbx reconcile --dry-run

  Enforcement boundary in sbx mode is the NETWORK (egress), not Docker-API
  filtering. Path rules apply fleet-wide at Huddle's proxy, never per-sandbox.

  Stop the bridge:  ./run-sandbox-mode.sh --stop   (= huddle sbx bridge stop)
EOF
