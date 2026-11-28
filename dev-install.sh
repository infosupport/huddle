#!/usr/bin/env bash
# dev-install.sh — Build & install Huddle from a LOCAL branch, no push, no CI.
#
# Shortens the loop: instead of push -> experiment-publish (CI) ->
# `huddle experiment use <nr>`, this builds the gateway image and the CLI from a
# branch that only exists in your local git, then runs `huddle init` against the
# locally-built gateway (HUDDLE_NO_PULL=1, so nothing is fetched from ghcr).
#
# Usage:
#   ./dev-install.sh <branch>               # gateway image + CLI + huddle init
#   ./dev-install.sh <branch> --no-init     # build + install CLI, don't start
#   ./dev-install.sh <branch> --cli-only    # only rebuild + reinstall the CLI
#   ./dev-install.sh <branch> --build-base  # also build the IntelliJ base image
#
# Env overrides:
#   HUDDLE_RUNTIME=docker|podman  container runtime            (default docker)
#   HUDDLE_DEV_IMAGE=<ref>        local gateway tag   (default …/huddle:dev-local)
#   HUDDLE_DEV_WORKTREE=<path>    build worktree      (default <repo>-dev-run)
#
# Run on the machine with Docker + the repo. Your current checkout is NEVER
# touched — the build happens in a dedicated, detached worktree at the branch tip
# (so uncommitted, unpushed commits on that branch are what gets built).
#
# Runs `huddle experiment reset` first: an experiment pinned in
# ~/.huddle/config.json makes `huddle init` reinstall that published CLI over
# this build. Re-pin afterwards with `huddle experiment use <nr>`.
set -euo pipefail

BRANCH="${1:-}"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "-h" ] || [ "$BRANCH" = "--help" ]; then
  sed -n '2,26p' "$0"; exit 2
fi
shift

DO_INIT=1; BUILD_BASE=0; CLI_ONLY=0
for a in "$@"; do
  case "$a" in
    --no-init)    DO_INIT=0 ;;
    --cli-only)   CLI_ONLY=1 ;;
    --build-base) BUILD_BASE=1 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

RT="${HUDDLE_RUNTIME:-docker}"
GATEWAY_IMAGE="${HUDDLE_DEV_IMAGE:-ghcr.io/infosupport/huddle:dev-local}"
ROOT="$(git rev-parse --show-toplevel)"
# Own worktree path (distinct from dev-build-run.sh's "-dev-run") so the two
# helpers never fight over the same checkout.
WT="${HUDDLE_DEV_WORKTREE:-${ROOT%/}-dev-install}"

for bin in git npm "$RT"; do
  command -v "$bin" >/dev/null || { echo "ERROR: '$bin' not found in PATH" >&2; exit 1; }
done
"$RT" info >/dev/null 2>&1 || { echo "ERROR: the '$RT' daemon is not reachable" >&2; exit 1; }

# Build LOCAL commits — no fetch, no reset. Verify the branch exists locally.
git -C "$ROOT" rev-parse --verify --quiet "$BRANCH^{commit}" >/dev/null \
  || { echo "ERROR: branch/ref '$BRANCH' not found locally" >&2; exit 1; }

# `huddle init` calls ensureCliForChannel(): when ~/.huddle/config.json pins an
# experiment, it npm-installs the published experiment CLI straight over the
# build we are about to install. A local build is by definition not an
# experiment build, so go back to stable first. That reset pulls @latest, which
# is fine — the local CLI is installed over it two steps down.
if command -v huddle >/dev/null; then
  echo "==> Back to the stable channel (an experiment pin would hijack 'huddle init')"
  huddle experiment reset || echo "    (!) 'huddle experiment reset' failed — continuing"
fi

# Dedicated DETACHED worktree at the branch tip: never moves the branch ref and
# works even when the branch is checked out elsewhere. Reuse only if it is a
# genuinely usable worktree — a stale/foreign one (e.g. left by another OS or an
# older run: "not a git repository") is torn down and recreated.
#
# Deliberately NOT `git worktree prune`. This repo is shared with the Huddle
# devcontainer (T:/projects/huddle here == /workspaces/huddle in there), and a
# prune deletes every registration whose path does not exist on THIS side — so
# running it on Windows unregisters the container's worktrees, and every git
# command in there starts failing with "not a git repository: (null)".
# Only ever drop OUR OWN registration.
COMMON="$(git -C "$ROOT" rev-parse --git-common-dir)"
case "$COMMON" in /*) ;; *) COMMON="$ROOT/$COMMON" ;; esac
drop_registration() { rm -rf "$COMMON/worktrees/$(basename "$WT")" 2>/dev/null || true; }

worktree_ok() { git -C "$WT" rev-parse --is-inside-work-tree >/dev/null 2>&1; }

if ! worktree_ok; then
  [ -e "$WT" ] && echo "==> $WT is not a usable worktree — recreating it" || true
  git -C "$ROOT" worktree remove --force "$WT" 2>/dev/null || true
  rm -rf "$WT" 2>/dev/null || true
  drop_registration
fi

if worktree_ok; then
  echo "==> Reusing worktree $WT"
  git -C "$WT" checkout -q --detach "$BRANCH"
else
  echo "==> Creating worktree $WT at $BRANCH"
  git -C "$ROOT" worktree add -q --detach "$WT" "$BRANCH"
fi
cd "$WT"
echo "==> Building from $BRANCH @ $(git rev-parse --short HEAD)"

# ── CLI: build + install globally as `huddle` (tiny deps → always clean-install)
echo "==> CLI: build + install globally"
npm --prefix cli ci
npm --prefix cli run build
npm i -g "$WT/cli"
echo "    huddle -> $(command -v huddle || echo '(not on PATH — check your npm global bin)')"

if [ "$CLI_ONLY" = 1 ]; then echo "==> --cli-only: done."; exit 0; fi

# ── Gateway image: build locally (same build context as CI: ./gateway) ────────
echo "==> Gateway: building $GATEWAY_IMAGE"
"$RT" build -t "$GATEWAY_IMAGE" "$WT/gateway"

# ── Base devimage: build (optional) or reuse a local one ──────────────────────
# HUDDLE_NO_PULL=1 (below) skips ALL pulls, so a base image must already be
# present for the gateway to start devcontainers. Point BASE_IMAGE_INTELLIJ at
# whatever we build or find.
BASE_REF=""
if [ "$BUILD_BASE" = 1 ]; then
  BASE_REF="ghcr.io/infosupport/base-devimage-intellij:dev-local"
  echo "==> Base: building $BASE_REF"
  "$RT" build -t "$BASE_REF" -f "$WT/base-devimage-intellij/Dockerfile" "$WT"
else
  BASE_REF="$("$RT" images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
             | grep -m1 'infosupport/base-devimage-intellij:' || true)"
  if [ -n "$BASE_REF" ]; then
    echo "==> Base: reusing local $BASE_REF"
  else
    echo "    (!) No local base-devimage-intellij found. The portal/gateway will run,"
    echo "        but STARTING a devcontainer needs a base image. Run 'huddle experiment"
    echo "        use <nr>' once to pull one, or re-run with --build-base."
  fi
fi

if [ "$DO_INIT" = 0 ]; then
  echo "==> --no-init: gateway image + CLI ready (gateway=$GATEWAY_IMAGE)"; exit 0
fi

# ── Run: init against the local gateway image, without pulling ────────────────
echo "==> huddle init (local image, no pull)"
INIT_ENV=(HUDDLE_IMAGE="$GATEWAY_IMAGE" HUDDLE_NO_PULL=1)
[ -n "$BASE_REF" ] && INIT_ENV+=(BASE_IMAGE_INTELLIJ="$BASE_REF")
env "${INIT_ENV[@]}" huddle init --runtime "$RT"

echo
echo "======================================================================"
echo " Huddle is up from $BRANCH @ $(git rev-parse --short HEAD)"
echo "   portal:  http://localhost:3000"
echo "   gateway: $GATEWAY_IMAGE   (local build — not pulled)"
[ -n "$BASE_REF" ] && echo "   base:    $BASE_REF"
echo
echo " After more changes on this branch, just re-run:"
echo "   ./dev-install.sh $BRANCH            (rebuild gateway + CLI + restart)"
echo "   ./dev-install.sh $BRANCH --cli-only (CLI only)"
echo "======================================================================"