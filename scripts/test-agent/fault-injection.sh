#!/usr/bin/env bash
# Proves the test agent can fail: injects a known security bug into the gateway source,
# runs the full test agent (run.sh) against it, and checks that the report flags the
# matching area. A green report only means something if a broken boundary turns it red.
#
# RUN THIS ONLY IN THE DISPOSABLE LINUX VM, on a clean checkout. It edits gateway/src
# temporarily and restores it with `git checkout -- gateway/src` when it ends.
#
# Usage:   scripts/test-agent/fault-injection.sh [--list] [fault ...]
#          (default: baseline privileged path-traversal; needs the same credential
#           environment variables as run.sh)
#
# Faults:
#   baseline         no change; must report no failures (checks for false alarms)
#   privileged       disables the "privileged containers not permitted" check in
#                    gateway/src/socket-proxy.ts       -> expects "Docker socket" to fail
#   path-traversal   disables the ".." rejection in normalizePathname in
#                    gateway/src/rules.ts              -> expects "Bypass attempts" to fail
#
# Every fault is a full run (about as long as a normal run.sh run). A run result of
# MISSED means the agent did not notice a real bug: tune the prompt before trusting it.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_SH="$REPO_DIR/scripts/test-agent/run.sh"
OUT_ROOT="${TEST_AGENT_OUT_ROOT:-$HOME/test-agent-out/fault-injection-$(date +%Y%m%d-%H%M%S)}"
ALL_FAULTS=(baseline privileged path-traversal)

log() { printf '\033[35m[fault-injection]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[fault-injection]\033[0m %s\n' "$*" >&2; exit 1; }

# Replace exactly one occurrence of a fixed string in a file; fail if it is not found once.
replace_once() { # <file> <old> <new>
  node -e '
    const fs = require("fs");
    const [file, oldText, newText] = process.argv.slice(1);
    const src = fs.readFileSync(file, "utf8");
    const n = src.split(oldText).length - 1;
    if (n !== 1) { console.error("expected exactly one occurrence in " + file + ", found " + n + ": " + oldText); process.exit(1); }
    fs.writeFileSync(file, src.replace(oldText, () => newText));
  ' "$@"
}

restore() { git -C "$REPO_DIR" checkout -- gateway/src; }

apply_fault() { # <fault>
  case "$1" in
    baseline) ;;
    privileged)
      replace_once "$REPO_DIR/gateway/src/socket-proxy.ts" \
        "if (hc.privileged === true) return 'Privileged containers not permitted';" \
        "if (false && hc.privileged === true) return 'Privileged containers not permitted';" ;;
    path-traversal)
      replace_once "$REPO_DIR/gateway/src/rules.ts" \
        "if (segs.some(s => s === '..')) return null;" \
        "if (false) return null;" ;;
    *) die "unknown fault: $1 (see --list)" ;;
  esac
}

expected_area() { # <fault> -> the report area that must fail ("" = nothing may fail)
  case "$1" in
    privileged)     echo "Docker socket" ;;
    path-traversal) echo "Bypass attempts" ;;
    *)              echo "" ;;
  esac
}

faults=()
for arg in "$@"; do
  case "$arg" in
    --list) printf '%s\n' "${ALL_FAULTS[@]}"; exit 0 ;;
    *)      faults+=("$arg") ;;
  esac
done
[ "${#faults[@]}" -gt 0 ] || faults=("${ALL_FAULTS[@]}")
for f in "${faults[@]}"; do
  printf '%s\n' "${ALL_FAULTS[@]}" | grep -qx -- "$f" || die "unknown fault: $f (see --list)"
done

[ "$(uname -s)" = Linux ] || die "run this on the Linux VM"
git -C "$REPO_DIR" diff --quiet -- gateway/src && git -C "$REPO_DIR" diff --cached --quiet -- gateway/src \
  || die "gateway/src has uncommitted changes. Commit or discard them first; this script restores that folder at the end."

mkdir -p "$OUT_ROOT"
log "results in $OUT_ROOT"
trap restore EXIT INT TERM

declare -A verdict
for fault in "${faults[@]}"; do
  log "=== fault: $fault ==="
  restore
  apply_fault "$fault"
  git -C "$REPO_DIR" --no-pager diff --stat -- gateway/src

  bash "$RUN_SH" --clean >/dev/null 2>&1 || true
  set +e
  TEST_AGENT_OUT="$OUT_ROOT/$fault" bash "$RUN_SH" >"$OUT_ROOT/$fault.run.out" 2>&1
  rc=$?
  set -e
  restore

  report="$OUT_ROOT/$fault/report.md"
  area="$(expected_area "$fault")"
  if [ ! -s "$report" ]; then
    verdict[$fault]="ERROR     no report was written (exit $rc), see $OUT_ROOT/$fault.run.out"
  elif [ -z "$area" ]; then
    if [ "$rc" = 0 ]; then verdict[$fault]="OK        no false alarm"
    else verdict[$fault]="FALSE ALARM  the unmodified code was flagged: $(grep -Ei ': FAIL|failed' "$report" | tr '\n' ';')"; fi
  elif grep -Eqi "^$area:.*(failed|FAIL)" "$report"; then
    verdict[$fault]="DETECTED  \"$area\" failed as expected"
  else
    verdict[$fault]="MISSED    \"$area\" did not fail; read $OUT_ROOT/$fault/evidence.md and agent.jsonl"
  fi
  log "$fault: ${verdict[$fault]}"
done

echo
log "summary"
bad=0
for fault in "${faults[@]}"; do
  printf '  %-15s %s\n' "$fault" "${verdict[$fault]}"
  case "${verdict[$fault]}" in OK*|DETECTED*) ;; *) bad=1 ;; esac
done
exit "$bad"
