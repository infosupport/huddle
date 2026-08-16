#!/bin/sh
# ── Container-side "sbx" — a file-mailbox client ──────────────────────────────
# Drop-in replacement for the `sbx` binary INSIDE the gateway container. It can't
# run sbx itself (sbx lives on Windows), so it forwards its argv to the host via a
# shared folder and waits for the answer:
#
#   1. write the argv to  <bridge>/req/<id>.req   (one arg per line, atomic rename)
#   2. wait for           <bridge>/res/<id>.code  (written LAST by the watcher)
#   3. replay stdout/stderr, exit with the real code
#
# The Windows side (bridge/sbx-watcher.sh) watches req/, runs sbx.exe, writes res/.
# Baked into the image as /usr/local/bin/sbx; the shared folder is mounted at
# $HUDDLE_SBX_BRIDGE (default /sbx-bridge).
set -u

BRIDGE="${HUDDLE_SBX_BRIDGE:-/sbx-bridge}"
REQ="$BRIDGE/req"
RES="$BRIDGE/res"
TIMEOUT_MS="${HUDDLE_SBX_BRIDGE_TIMEOUT_MS:-300000}"

mkdir -p "$REQ" "$RES" 2>/dev/null || true
if [ ! -d "$REQ" ]; then
  echo "sbx bridge folder '$BRIDGE' is not mounted into the container" >&2
  exit 127
fi

# Unique id: seconds + pid + awk-random (busybox-safe, no $RANDOM dependency).
rnd="$(awk 'BEGIN{srand();printf "%06d", rand()*1000000}')"
id="$(date +%s)-$$-$rnd"
tmp="$REQ/$id.req.tmp"
req="$REQ/$id.req"

: > "$tmp"
for a in "$@"; do printf '%s\n' "$a" >> "$tmp"; done
mv "$tmp" "$req"                       # atomic: watcher only ever sees a complete req

codef="$RES/$id.code"
outf="$RES/$id.out"
errf="$RES/$id.err"

# Poll for the completion marker. 150ms steps.
max=$(( TIMEOUT_MS / 150 ))
i=0
while [ ! -f "$codef" ]; do
  i=$(( i + 1 ))
  if [ "$i" -ge "$max" ]; then
    echo "sbx bridge timeout after ${TIMEOUT_MS}ms — is the Windows watcher running (bridge/sbx-watcher.sh)?" >&2
    rm -f "$req"
    exit 124
  fi
  sleep 0.15
done

[ -f "$outf" ] && cat "$outf"
[ -f "$errf" ] && cat "$errf" >&2
code="$(cat "$codef" 2>/dev/null)"
rm -f "$req" "$outf" "$errf" "$codef" 2>/dev/null || true
exit "${code:-1}"
