// ── Custom base images: the Huddle layer ─────────────────────────────────────
// A devcontainer may start from any image the operator picks, not only Huddle's
// own base images. Such an image comes with its own users and privilege paths
// (passwordless sudo, uid 0 as default user, doas, setuid binaries …), so it is
// never run as-is: the gateway first builds a derived image
//
//     FROM <custom image>  +  huddle-layer.sh  →  huddle-custom/<name>:<id>-l<v>
//
// The layer installs what the runtime config scripts need, makes `vscode` the dev
// user, strips every route to root except the `noot` sudo grant, and ends with a
// doctor check: if any check fails the build fails and the container is not
// created. The build runs on the container's own internal dc-net network with
// Huddle as proxy, so its downloads go through the allowlist and the audit log.
//
// This module holds the pure parts (naming, trust decision, Dockerfile, script)
// so they can be unit-tested without Docker; docker.ts does the orchestration.

/** Bump when the layer script changes: derived images are cached per version. */
export const HUDDLE_LAYER_VERSION = '1';

/** Set on Huddle's own base image and on every derived image. */
export const HUDDLE_LAYER_LABEL = 'io.huddle.layer';
const LAYER_VERSION_LABEL = 'io.huddle.layer.version';

/** Local repository the derived images are tagged in. */
export const DERIVED_IMAGE_REPO = 'huddle-custom';

// Docker image reference: [registry[:port]/]path[:tag][@sha256:digest]. Strict on
// purpose — the reference is written into a Dockerfile, so whitespace, quotes or
// newlines must never get through.
const IMAGE_REF = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

export function isValidImageRef(ref: string): boolean {
  return typeof ref === 'string' && ref.length <= 255 && IMAGE_REF.test(ref);
}

/** The repository part of a reference: without tag and digest. */
export function imageRepo(ref: string): string {
  const noDigest = ref.split('@')[0];
  const lastSlash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  return colon > lastSlash ? noDigest.slice(0, colon) : noDigest;
}

/** Reference with an explicit tag: a pull without one would fetch every tag. */
export function withDefaultTag(ref: string): string {
  return ref.includes('@') || imageRepo(ref) !== ref ? ref : `${ref}:latest`;
}

/**
 * Whether an image may run without the Huddle layer. Only images whose origin
 * Huddle controls: the configured base images (by repository, any tag),
 * snapshots committed from a Huddle container, and derived images of the current
 * layer version. A label alone is not enough for an arbitrary image — anyone can
 * set `io.huddle.layer` in their Dockerfile.
 */
export function needsHuddleLayer(ref: string, labels: Record<string, string> | undefined, baseImages: string[]): boolean {
  const repo = imageRepo(ref);
  if (baseImages.some(b => imageRepo(b) === repo)) return false;
  if (labels?.['com.devcontainer.snapshot'] === 'true') return false;
  if (repo === DERIVED_IMAGE_REPO || repo.startsWith(`${DERIVED_IMAGE_REPO}/`)) {
    return labels?.[HUDDLE_LAYER_LABEL] !== 'custom' || labels?.[LAYER_VERSION_LABEL] !== HUDDLE_LAYER_VERSION;
  }
  return true;
}

/** Tag of the derived image: one per (image id, layer version). */
export function derivedImageName(ref: string, imageId: string): string {
  const name = imageRepo(ref)
    .replace(/[^a-z0-9._/-]/g, '-')
    .split('/').filter(Boolean).join('-')
    .replace(/^[._-]+/, '')
    .slice(0, 100) || 'image';
  const id = imageId.replace(/^sha256:/, '').slice(0, 12);
  return `${DERIVED_IMAGE_REPO}/${name}:${id}-l${HUDDLE_LAYER_VERSION}`;
}

export function buildLayerDockerfile(ref: string): string {
  if (!isValidImageRef(ref)) throw new Error(`Invalid image reference: ${ref}`);
  return [
    `FROM ${ref}`,
    'USER root',
    'COPY huddle-ca.crt huddle-layer.sh /opt/huddle/',
    'RUN sh /opt/huddle/huddle-layer.sh',
    `LABEL ${HUDDLE_LAYER_LABEL}="custom" ${LAYER_VERSION_LABEL}="${HUDDLE_LAYER_VERSION}" io.huddle.layer.base="${ref}"`,
    'USER vscode',
    '',
  ].join('\n');
}

/**
 * Runs as root during the derived-image build. POSIX sh (also busybox ash).
 * Written with String.raw: no `${…}` in here, shell variables are plain `$VAR`.
 */
export const HUDDLE_LAYER_SCRIPT = String.raw`#!/bin/sh
# Huddle layer — applied on top of a custom base image (gateway/src/custom-image.ts).
set -eu
export LC_ALL=C
DEV=vscode
log() { echo "[huddle-layer] $*"; }
fail() { echo "[huddle-layer] FAILED: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || fail "must run as root"

# ── 1. Packages the runtime config scripts rely on ──────────────────────────
NEED="sudo iptables curl update-ca-certificates useradd usermod groupadd groupmod gpasswd chpasswd passwd getent base64 awk sshd inotifywait"
missing_cmds() {
  m=""
  for c in $NEED; do command -v "$c" >/dev/null 2>&1 || m="$m $c"; done
  echo "$m"
}
if [ -n "$(missing_cmds)" ]; then
  log "installing:$(missing_cmds)"
  # The downloads go through the Huddle proxy, which intercepts HTTPS.
  for b in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem; do
    if [ -f "$b" ]; then cat /opt/huddle/huddle-ca.crt >> "$b"; fi
  done
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y --no-install-recommends sudo iptables curl ca-certificates passwd libc-bin coreutils openssh-server inotify-tools
    rm -rf /var/lib/apt/lists/*
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache sudo iptables curl ca-certificates shadow coreutils musl-utils openssh-server inotify-tools
  else
    fail "unsupported image: Huddle needs apt (Debian/Ubuntu) or apk (Alpine)"
  fi
  [ -z "$(missing_cmds)" ] || fail "still missing after install:$(missing_cmds)"
fi

# ── 2. Dev user 'vscode' ────────────────────────────────────────────────────
# The runtime scripts, IDE metadata and folder mappings all assume vscode with
# home /home/vscode. An existing uid-1000 user (node, ubuntu, …) is renamed so
# file ownership in the image stays intact.
if ! id "$DEV" >/dev/null 2>&1; then
  OLD=$(awk -F: '$3 == 1000 { print $1; exit }' /etc/passwd)
  if [ -n "$OLD" ]; then
    log "renaming user $OLD (uid 1000) to $DEV"
    usermod -l "$DEV" "$OLD"
    OLDGRP=$(id -gn "$DEV")
    if [ "$OLDGRP" = "$OLD" ] && ! getent group "$DEV" >/dev/null; then groupmod -n "$DEV" "$OLD"; fi
  else
    if ! getent group "$DEV" >/dev/null; then
      if getent group 1000 >/dev/null; then groupadd "$DEV"; else groupadd -g 1000 "$DEV"; fi
    fi
    SH=/bin/sh; if [ -x /bin/bash ]; then SH=/bin/bash; fi
    useradd -m -u 1000 -g "$DEV" -s "$SH" "$DEV"
  fi
fi
[ "$(id -u "$DEV")" != 0 ] || fail "user $DEV has uid 0"
getent group "$DEV" >/dev/null || groupadd "$DEV"
usermod -g "$DEV" "$DEV"
if [ "$(getent passwd "$DEV" | cut -d: -f6)" != "/home/$DEV" ]; then usermod -d "/home/$DEV" -m "$DEV"; fi
mkdir -p "/home/$DEV"
# No usable password, but not "locked" either: sshd without PAM (Alpine) refuses
# key logins for a locked ('!') account.
usermod -p '*' "$DEV"
getent group docker >/dev/null || groupadd docker
usermod -aG docker "$DEV"
# Mount targets of the folder mappings (same as base-devimage/Dockerfile).
mkdir -p "/home/$DEV/.claude/agents" "/home/$DEV/.claude/skills" "/home/$DEV/.codex" "/home/$DEV/.copilot" \
         "/home/$DEV/.config/opencode/agents" "/home/$DEV/.ai/mcp"
chown -R "$DEV:$DEV" "/home/$DEV"

# ── 3. Strip every route to root ────────────────────────────────────────────
for g in sudo wheel admin root; do
  if id -nG "$DEV" | tr ' ' '\n' | grep -qx "$g"; then gpasswd -d "$DEV" "$g" >/dev/null; fi
done
# The whole sudo policy is ours: images often ship NOPASSWD rules in sudoers.d.
# Only the admin groups remain; the runtime adds the locked 'noot' user to one of
# them and unlocks it per grant (sudo-grant.ts).
cat > /etc/sudoers <<'EOF'
# Written by the Huddle layer. The runtime adds /etc/sudoers.d/99-huddle-audit.
Defaults env_reset
Defaults secure_path="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
root ALL=(ALL:ALL) ALL
%sudo ALL=(ALL:ALL) ALL
%wheel ALL=(ALL:ALL) ALL
#includedir /etc/sudoers.d
EOF
chmod 440 /etc/sudoers
rm -rf /etc/sudoers.d
mkdir -m 755 /etc/sudoers.d
rm -rf /etc/doas.conf /etc/doas.d
usermod -p '!' root
# setuid/setgid binaries other than sudo, and file capabilities.
SUDO_BIN=$(readlink -f "$(command -v sudo)")
find / -xdev -type f \( -perm -4000 -o -perm -2000 \) 2>/dev/null | while IFS= read -r f; do
  [ "$(readlink -f "$f")" = "$SUDO_BIN" ] || chmod u-s,g-s "$f"
done
if command -v getcap >/dev/null 2>&1 && command -v setcap >/dev/null 2>&1; then
  for d in /bin /sbin /usr /opt /lib /lib64; do
    [ -d "$d" ] && getcap -r "$d" 2>/dev/null | awk '{ print $1 }' | while IFS= read -r f; do setcap -r "$f" 2>/dev/null || true; done
  done
fi
# Host keys are generated per container (ssh-access.ts), never shared per image.
rm -f /etc/ssh/ssh_host_*
rm -f /opt/huddle/huddle-ca.crt

# ── 4. Doctor: fail the build when anything is off ──────────────────────────
ok=1
check() {
  if eval "$2"; then log "ok: $1"; else echo "[huddle-layer] FAIL: $1" >&2; ok=0; fi
}
check "required commands present" '[ -z "$(missing_cmds)" ]'
check "$DEV is not root" '[ "$(id -u "$DEV")" != 0 ] && [ "$(id -g "$DEV")" != 0 ]'
check "$DEV has home /home/$DEV" '[ "$(getent passwd "$DEV" | cut -d: -f6)" = "/home/$DEV" ]'
check "$DEV is in no admin group" '! id -nG "$DEV" | tr " " "\n" | grep -qxE "sudo|wheel|admin|root"'
check "sudo denies $DEV" 'sudo -n -l -U "$DEV" 2>&1 | grep -q "is not allowed to run sudo"'
check "root account locked" 'awk -F: '"'"'$1 == "root" { exit !($2 ~ /^[!*]/) }'"'"' /etc/shadow'
check "sudo is setuid root" '[ -u "$SUDO_BIN" ]'
check "no doas" '[ ! -e /etc/doas.conf ]'
check "no setuid/setgid besides sudo" '[ -z "$(find / -xdev -type f \( -perm -4000 -o -perm -2000 \) 2>/dev/null | while IFS= read -r f; do [ "$(readlink -f "$f")" = "$SUDO_BIN" ] || echo "$f"; done)" ]'
[ "$ok" = 1 ] || fail "doctor checks failed"
log "done"
`;
