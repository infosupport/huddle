#!/usr/bin/env bash
#
# install-ide.sh - runs INSIDE the container, as the non-root dev user.
# Downloads an IDE backend / server at runtime, installs plugins, starts it.
#
#   install-ide.sh install <ide> [pluginId ...]
#   install-ide.sh run     <ide> <link-host> <ssh-port>
#
#   <ide> = intellij | rider | vscode
#
# Everything lands under ~/.cache so it can be a volume (warm restarts).

set -euo pipefail

if [ "$(id -u)" = 0 ]; then
    echo "install-ide.sh: refusing to run as root - the backend forks the developer's shell" >&2
    exit 78
fi

CACHE="${CACHE_ROOT:-$HOME/.cache}"
JB_DIST="$CACHE/JetBrains/RemoteDev/dist"
OVS_ROOT="$CACHE/openvscode"
LOG="$HOME/backend.log"

# Pinned fallback: the GitHub releases API is not always reachable through
# Huddle's proxy. We try to resolve the latest tag first and only fall back.
OVS_FALLBACK_VERSION="${OVS_VERSION:-1.104.2}"

log() { printf '\033[1;34m[install-ide]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[install-ide] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# JetBrains: IntelliJ IDEA Ultimate and Rider share one code path. The only
# difference is the product code - the tarball layout, remote-dev-server.sh
# and installPlugins behave identically.
# ---------------------------------------------------------------------------
jb_code() {
    case "$1" in
        intellij) echo IIU ;;   # IntelliJ IDEA Ultimate
        rider)    echo RD  ;;   # Rider
        *) return 1 ;;
    esac
}

jb_backend_dir() {
    # Match on the product's tarball prefix so IntelliJ and Rider can share a
    # volume without finding each other: idea-* vs JetBrains.Rider-*
    local prefix; prefix="$(jb_dir_prefix "$1")"
    find "$JB_DIST" -maxdepth 1 -mindepth 1 -type d -name "${prefix}*" \
         -exec test -x '{}/bin/remote-dev-server.sh' \; -print 2>/dev/null | head -1
}

jb_dir_prefix() {
    case "$1" in
        intellij) echo 'idea-' ;;
        rider)    echo 'JetBrains.Rider-' ;;
        *) return 1 ;;
    esac
}

jb_install() {
    local ide="$1"; shift
    local code url tarball name dir t0 t1
    code="$(jb_code "$ide")" || die "not a JetBrains IDE: $ide"
    mkdir -p "$JB_DIST"

    # Stable redirect endpoint: 302s to the current build, so no hardcoded
    # version and only one host to allowlist.
    url="$(curl -fsSI -m 60 \
        "https://download.jetbrains.com/product?code=${code}&latest=true&distribution=linux" \
        | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | tail -1)"
    [ -n "$url" ] || die "could not resolve the download URL for $ide ($code)"

    tarball="$(basename "${url%%\?*}")"
    name="${tarball%.tar.gz}"
    dir="$JB_DIST/$name"

    log "ide=$ide product=$code build=$name"
    log "url=$url"

    if [ -x "$dir/bin/remote-dev-server.sh" ]; then
        log "cache HIT - already unpacked, skipping download"
    else
        log "cache MISS - downloading (IntelliJ ~1.5 GB, Rider ~2.2 GB)"
        t0=$(date +%s)
        curl -fSL --retry 3 --retry-delay 2 -m 3600 -o "/tmp/$tarball" "$url" \
            || die "download failed"
        t1=$(date +%s); log "downloaded in $((t1-t0))s"

        log "extracting"
        mkdir -p "$dir"
        # one versioned top-level dir in the tarball -> strip it so bin/ lands
        # where Gateway expects it
        tar -xzf "/tmp/$tarball" -C "$dir" --strip-components=1 || die "extract failed"
        log "unpacked: $(du -sh "$dir" | cut -f1)"
        rm -f "/tmp/$tarball"
    fi

    [ -x "$dir/bin/remote-dev-server.sh" ] || die "remote-dev-server.sh missing after install"

    log "registering backend location for Gateway"
    "$dir/bin/remote-dev-server.sh" registerBackendLocationForGateway \
        || log "WARN: registration returned non-zero (not fatal)"

    if [ "$#" -gt 0 ]; then
        # Correct 2026.x signature: installPlugins <pluginId>...
        # NOT `installPlugins <PROJECT_PATH> <pluginId>` as older docs claim -
        # a path there is parsed as a plugin id, reported as "unknown plugins",
        # and the command still exits 0. It fails silently.
        #
        # --give-consent-to-use-third-party-plugins is required or non-JetBrains
        # plugins install but come up DISABLED.
        log "installing plugins: $*"
        t0=$(date +%s)
        "$dir/bin/remote-dev-server.sh" installPlugins "$@" \
            --give-consent-to-use-third-party-plugins || die "plugin install failed"
        t1=$(date +%s); log "plugins installed in $((t1-t0))s"
    fi

    log "plugins on disk:"
    find "$HOME/.local/share/JetBrains" -maxdepth 2 -mindepth 2 -type d \
        -printf '    %f\n' 2>/dev/null | sort || true
}

jb_run() {
    local ide="$1" host="$2" port="$3" dir
    dir="$(jb_backend_dir "$ide")"; [ -n "$dir" ] || die "no $ide backend installed"

    mkdir -p "$PROJECT"
    log "starting $ide backend for $PROJECT (log: $LOG)"

    # REMOTE_DEV_NON_INTERACTIVE: no shell prompts (there is no TTY)
    # REMOTE_DEV_TRUST_PROJECTS: skip the "trust this project?" modal, which
    #   otherwise blocks an unattended start forever
    setsid env \
        REMOTE_DEV_NON_INTERACTIVE=1 \
        REMOTE_DEV_TRUST_PROJECTS=1 \
        "$dir/bin/remote-dev-server.sh" run "$PROJECT" \
            --ssh-link-host "$host" \
            --ssh-link-user "$(id -un)" \
            --ssh-link-port "$port" \
        > "$LOG" 2>&1 < /dev/null &

    log "backend pid $! - the Gateway link appears in $LOG"
}

# ---------------------------------------------------------------------------
# VS Code: OpenVSCode Server.
#
# openvscode-server is upstream VS Code with the server entrypoint kept, and
# its CLI takes --install-extension directly, resolving against Open VSX.
# code-server would also work but its extension resolution differs; this keeps
# the CLI closest to `code`.
#
# Unlike the JetBrains backends there is no "register for Gateway" step and no
# SSH hop needed to use it - it serves the editor over HTTP itself.
# ---------------------------------------------------------------------------
ovs_resolve_version() {
    local tag
    tag="$(curl -fsSI -m 45 "https://github.com/gitpod-io/openvscode-server/releases/latest" \
        | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}' | tail -1)"
    tag="${tag##*/openvscode-server-v}"
    if printf '%s' "$tag" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        printf '%s\n' "$tag"
    else
        printf '%s\n' "$OVS_FALLBACK_VERSION"
    fi
}

ovs_dir() {
    find "$OVS_ROOT" -maxdepth 1 -mindepth 1 -type d -name 'openvscode-server-*' \
         -exec test -x '{}/bin/openvscode-server' \; -print 2>/dev/null | head -1
}

ovs_install() {
    shift || true   # drop the ide arg; the rest are extension ids
    local ver tarball url dir t0 t1
    mkdir -p "$OVS_ROOT"

    ver="$(ovs_resolve_version)"
    tarball="openvscode-server-v${ver}-linux-x64.tar.gz"
    url="https://github.com/gitpod-io/openvscode-server/releases/download/openvscode-server-v${ver}/${tarball}"
    dir="$OVS_ROOT/openvscode-server-v${ver}-linux-x64"

    log "ide=vscode version=$ver"
    log "url=$url"

    if [ -x "$dir/bin/openvscode-server" ]; then
        log "cache HIT - already unpacked, skipping download"
    else
        log "cache MISS - downloading (~200 MB)"
        t0=$(date +%s)
        curl -fSL --retry 3 --retry-delay 2 -m 1800 -o "/tmp/$tarball" "$url" \
            || die "download failed (is github.com allowed by the network policy?)"
        t1=$(date +%s); log "downloaded in $((t1-t0))s"

        log "extracting"
        tar -xzf "/tmp/$tarball" -C "$OVS_ROOT" || die "extract failed"
        log "unpacked: $(du -sh "$dir" | cut -f1)"
        rm -f "/tmp/$tarball"
    fi

    [ -x "$dir/bin/openvscode-server" ] || die "openvscode-server binary missing after extract"

    if [ "$#" -gt 0 ]; then
        log "installing extensions: $*"
        local ext rc=0
        # One flag per extension, one invocation each. Batching is faster but a
        # single bad id fails the whole batch - a typo in devcontainer.json
        # should not stop the container from coming up.
        for ext in "$@"; do
            t0=$(date +%s)
            if "$dir/bin/openvscode-server" --install-extension "$ext" --force; then
                t1=$(date +%s); log "  ok   $ext ($((t1-t0))s)"
            else
                log "  FAIL $ext"; rc=1
            fi
        done
        [ "$rc" = 0 ] || log "WARN: one or more extensions failed"
    fi

    log "extensions on disk:"
    "$dir/bin/openvscode-server" --list-extensions --show-versions 2>/dev/null \
        | sed 's/^/    /' || log "    (--list-extensions failed)"
}

ovs_run() {
    local dir port="${OVS_PORT:-3000}"
    dir="$(ovs_dir)"; [ -n "$dir" ] || die "no openvscode-server installed"
    mkdir -p "$PROJECT"
    log "starting openvscode-server on 0.0.0.0:${port} (log: $LOG)"

    # --without-connection-token: no token in the URL. POC only; it means
    # anyone who can reach the port gets the editor.
    setsid "$dir/bin/openvscode-server" \
        --host 0.0.0.0 --port "$port" \
        --without-connection-token \
        "$PROJECT" \
        > "$LOG" 2>&1 < /dev/null &

    log "server pid $! - open http://localhost:${port}/?folder=${PROJECT}"
}

# ---------------------------------------------------------------------------
PROJECT="${PROJECT:-/workspace}"

case "${1:-}" in
    install)
        shift
        ide="${1:-}"
        [ -n "$ide" ] || die "usage: install-ide.sh install <intellij|rider|vscode> [ids...]"
        case "$ide" in
            intellij|rider) jb_install "$@" ;;
            vscode)         ovs_install "$@" ;;
            *) die "unknown ide '$ide' (intellij|rider|vscode)" ;;
        esac
        ;;
    run)
        shift
        ide="${1:-}"
        [ -n "$ide" ] || die "usage: install-ide.sh run <intellij|rider|vscode> <link-host> <ssh-port>"
        case "$ide" in
            intellij|rider) jb_run "$ide" "${2:-localhost}" "${3:-2222}" ;;
            vscode)         ovs_run ;;
            *) die "unknown ide '$ide' (intellij|rider|vscode)" ;;
        esac
        ;;
    *)
        die "usage: install-ide.sh install <ide> [ids...] | run <ide> <host> <port>"
        ;;
esac
