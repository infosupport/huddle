#!/usr/bin/env bash
# ── Windows-side watcher — runs the real sbx.exe ──────────────────────────────
# The other half of the file-mailbox. Runs NATIVELY on Windows (git bash), watches
# the shared folder for request files the container drops, executes `sbx` with the
# given args, and writes the result back with the same id:
#
#   req/<id>.req   (argv, one per line)  ──▶  run sbx  ──▶  res/<id>.out / .err / .code
#
# The .code file is written LAST (atomic rename) so the container only reads a
# fully-written response. See bridge/sbx.sh for the container side.
set -u

BRIDGE="${HUDDLE_SBX_BRIDGE_WIN:-$HOME/.huddle-sbx}"
SBX="${HUDDLE_SBX_BIN:-sbx}"          # sbx.exe on PATH in git bash
POLL="${HUDDLE_SBX_BRIDGE_POLL:-0.15}"
REQ="$BRIDGE/req"
RES="$BRIDGE/res"

# On Windows, translate MSYS-style path args (/t/projects/x) to Windows paths
# (T:\projects\x) so `sbx create ... <workspace>` works with a git-bash $PWD.
# Only args that look like a drive path are touched; domains/CIDRs/flags pass
# through untouched. Disable with HUDDLE_SBX_NO_PATH_XLATE=1.
IS_WIN=0
case "$(uname -s 2>/dev/null || echo x)" in MINGW*|MSYS*|CYGWIN*) IS_WIN=1 ;; esac
xlate() {
  local a="$1"
  if [ "$IS_WIN" = 1 ] && [ "${HUDDLE_SBX_NO_PATH_XLATE:-0}" != 1 ]; then
    case "$a" in
      /[a-zA-Z]/*)
        if command -v cygpath >/dev/null 2>&1; then cygpath -w "$a"; return; fi
        local d r; d="$(printf %s "$a" | cut -c2 | tr a-z A-Z)"; r="$(printf %s "$a" | cut -c4- | tr / '\\')"
        printf '%s:\\%s' "$d" "$r"; return ;;
    esac
  fi
  printf '%s' "$a"
}

mkdir -p "$REQ" "$RES"
echo "[sbx-watcher] watching $REQ"
echo "[sbx-watcher] sbx      = $SBX ($("$SBX" version 2>/dev/null | head -1 || echo 'NOT FOUND on PATH'))"
echo "[sbx-watcher] Ctrl+C to stop."

cleanup() { echo; echo "[sbx-watcher] stopped."; exit 0; }
trap cleanup INT TERM

while true; do
  shopt -s nullglob
  for req in "$REQ"/*.req; do
    id="$(basename "$req" .req)"
    # read argv (one per line) — mapfile keeps args with spaces intact
    mapfile -t raw < "$req"
    args=(); for a in "${raw[@]}"; do args+=("$(xlate "$a")"); done
    out="$RES/$id.out"; err="$RES/$id.err"; code="$RES/$id.code"
    if [ "${#args[@]}" -eq 0 ]; then
      : > "$out"; echo "empty request" > "$err"; rc=2
    else
      "$SBX" "${args[@]}" >"$out" 2>"$err"; rc=$?
    fi
    printf '%s' "$rc" > "$code.tmp" && mv "$code.tmp" "$code"   # marker written last
    rm -f "$req"
    echo "[sbx-watcher] $id : ${args[*]:-<empty>} -> exit $rc"
  done
  shopt -u nullglob
  sleep "$POLL"
done
