#!/usr/bin/env bash
#
# run-poc.sh - the whole POC, start to finish, for one IDE or all of them:
#
#   1. build the slim SSH image (no IDE in it)
#   2. start a container for the chosen IDE on that IDE's own port
#   3. get a shell inside it as the non-root 'dev' user
#   4. download + install the IDE backend / server
#   5. install plugins / extensions non-interactively
#   6. start it and print how to connect
#
# Usage:
#   ./run-poc.sh                       # intellij (default)
#   ./run-poc.sh rider
#   ./run-poc.sh vscode
#   ./run-poc.sh all                   # all three, side by side
#   ./run-poc.sh intellij IdeaVIM org.sonarlint.idea
#
#   ./run-poc.sh --links [ide]         # every link/URL the IDE published
#   ./run-poc.sh --ports               # which port belongs to which IDE
#   ./run-poc.sh --stop [ide]          # tear down (no ide = all)
#
# Env: SSH_ID (bind the Gateway link to a saved Gateway connection),
#      LINK_HOST (localhost), DEV_PASSWORD (dev), IMAGE
#
# There is no SSH key anywhere in this POC. Auth is the dev user's password.

set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${IMAGE:-huddle-poc/ide-ssh:latest}"
LINK_HOST="${LINK_HOST:-localhost}"
DEV_PASSWORD="${DEV_PASSWORD-dev}"

# ---------------------------------------------------------------------------
# One port per IDE, so all three can run at once without collisions. The web
# port is only used by the vscode flow.
#
#   ide        ssh    web    default plugins/extensions
# ---------------------------------------------------------------------------
ide_ssh_port() {
    case "$1" in
        intellij) echo 2222 ;;
        rider)    echo 2223 ;;
        vscode)   echo 2224 ;;
        *) return 1 ;;
    esac
}
ide_web_port() {
    case "$1" in
        vscode) echo 3000 ;;
        *)      echo "" ;;
    esac
}
ide_default_plugins() {
    case "$1" in
        # a JetBrains plugin plus third-party ones, so the
        # --give-consent-to-use-third-party-plugins path is exercised
        intellij) echo "IdeaVIM org.sonarlint.idea zielu.gittoolbox" ;;
        rider)    echo "IdeaVIM org.sonarlint.idea" ;;
        vscode)   echo "vscodevim.vim ms-python.python" ;;
        *) return 1 ;;
    esac
}
ide_container() { echo "huddle-poc-$1"; }
# A volume per IDE rather than one shared one: the JetBrains dists could share
# safely (distinct directory prefixes), but two backends writing the same
# ~/.cache concurrently is a race nobody needs in a POC.
ide_volume()    { echo "huddle-poc-cache-$1"; }

ALL_IDES="intellij rider vscode"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*"; }
die()  { printf '\n\033[1;31mXX  %s\033[0m\n' "$*" >&2; exit 1; }

valid_ide() { ide_ssh_port "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Running commands inside the container.
#
# The provisioning steps go over SSH when sshpass is available, which is the
# flow this POC is meant to demonstrate. Without a key there is no other way
# to feed a password to ssh non-interactively, so the fallback is
# `docker exec -u dev`. Both run as the non-root dev user and both drive the
# same install-ide.sh, so the install being tested is identical - only the
# transport differs. In real Huddle the host-side agent would use the latter
# anyway; SSH is what the *developer's* IDE client uses.
# ---------------------------------------------------------------------------
TRANSPORT=""
pick_transport() {
    if command -v sshpass >/dev/null 2>&1; then
        TRANSPORT=ssh
    else
        TRANSPORT=exec
    fi
}

in_container() {          # in_container <ide> <command...>
    local ide="$1"; shift
    local port; port="$(ide_ssh_port "$ide")"
    if [ "$TRANSPORT" = ssh ]; then
        sshpass -p "$DEV_PASSWORD" ssh \
            -p "$port" \
            -o StrictHostKeyChecking=no \
            -o UserKnownHostsFile=/dev/null \
            -o PreferredAuthentications=password,keyboard-interactive \
            -o LogLevel=ERROR \
            "dev@${LINK_HOST}" "$@"
    else
        # bash -c, not -lc: a login shell may print motd/profile noise, which
        # corrupts the output of the calls whose result we capture.
        docker exec -u dev -e PROJECT=/workspace "$(ide_container "$ide")" \
            bash -c "$*"
    fi
}

# ---------------------------------------------------------------------------
ports() {
    step "port map"
    printf '    %-10s %-6s %-6s %s\n' IDE SSH WEB CONTAINER
    local i
    for i in $ALL_IDES; do
        printf '    %-10s %-6s %-6s %s\n' \
            "$i" "$(ide_ssh_port "$i")" "$(ide_web_port "$i" || true)" "$(ide_container "$i")"
    done
    printf '\n'
    info "login: user 'dev', password '${DEV_PASSWORD:-<empty>}' - no keys in this POC"
    exit 0
}

stop() {
    local targets="${1:-$ALL_IDES}" i
    step "tearing down: $targets"
    for i in $targets; do
        docker rm -f "$(ide_container "$i")" >/dev/null 2>&1 \
            && info "removed $(ide_container "$i")" \
            || info "no container for $i"
    done
    printf '\n'
    info "cache volumes kept, so the next run is warm. To reclaim the disk:"
    for i in $targets; do printf '        docker volume rm %s\n' "$(ide_volume "$i")"; done
    exit 0
}

links() {
    local ide="${1:-intellij}"
    valid_ide "$ide" || die "unknown ide '$ide'"
    pick_transport
    step "$ide: everything it published"
    in_container "$ide" 'grep -nE "link|tcp://|https://|jetbrains-gateway://|Web UI" ~/backend.log' \
        | sed 's/^/    /' || die "no backend.log for $ide - has it been started?"
    exit 0
}

case "${1:-}" in
    --ports) ports ;;
    --stop)  stop "${2:-}" ;;
    --links) links "${2:-}" ;;
esac

# Validate the target before spending a preflight and a build on it.
TARGET="${1:-intellij}"
if [ "$TARGET" != all ] && ! valid_ide "$TARGET"; then
    die "unknown ide '$TARGET' - expected intellij, rider, vscode or all"
fi
shift || true

# ---------------------------------------------------------------------------
step "0/6  preflight: hosts this POC has to reach"
for probe in \
    "https://download.jetbrains.com/product?code=IIU&latest=true&distribution=linux|IntelliJ backend tarball" \
    "https://download.jetbrains.com/product?code=RD&latest=true&distribution=linux|Rider backend tarball" \
    "https://plugins.jetbrains.com/api/searchPlugins?search=ideavim&max=1|JB Marketplace API" \
    "https://downloads.marketplace.jetbrains.com/|JB Marketplace binaries" \
    "https://github.com/gitpod-io/openvscode-server/releases/latest|openvscode-server release" \
    "https://open-vsx.org/api/-/search?size=1|Open VSX (vscode extensions)" \
    "https://registry-1.docker.io/v2/|container registry (base image)" \
    "https://deb.debian.org/debian/dists/trixie/Release|Debian archive (apt)" ; do
    url="${probe%%|*}"; label="${probe##*|}"
    code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$url" 2>/dev/null) || true
    # 401/403 still prove the host answered: Docker Hub's /v2/ wants a token and
    # an S3 bucket root denies listing. Only a dead connection or a proxy error
    # means blocked.
    case "${code:-000}" in
        2*|30*|401|403) printf '    \033[1;32m%-4s\033[0m %s\n' "$code" "$label" ;;
        *)              printf '    \033[1;31m%-4s\033[0m %s  <- BLOCKED\n' "${code:-000}" "$label" ;;
    esac
done

# ---------------------------------------------------------------------------
step "1/6  build the slim SSH image (no IDE inside)"
docker build \
    --build-arg HTTP_PROXY="${HTTP_PROXY:-}" \
    --build-arg HTTPS_PROXY="${HTTPS_PROXY:-}" \
    --build-arg NO_PROXY="${NO_PROXY:-}" \
    -t "$IMAGE" . || die "build failed (is the base image / apt reachable?)"
docker image ls "$IMAGE" --format '    {{.Repository}}:{{.Tag}}  {{.Size}}'

pick_transport
info "provisioning transport: $TRANSPORT$([ "$TRANSPORT" = exec ] && printf ' (install sshpass to drive it over SSH instead)')"

# ---------------------------------------------------------------------------
run_ide() {
    local ide="$1"; shift
    local plugins=("$@")
    [ "${#plugins[@]}" -gt 0 ] || read -r -a plugins <<< "$(ide_default_plugins "$ide")"

    local ssh_port web_port container volume
    ssh_port="$(ide_ssh_port "$ide")"
    web_port="$(ide_web_port "$ide" || true)"
    container="$(ide_container "$ide")"
    volume="$(ide_volume "$ide")"

    step "2/6  $ide: start the container (ssh :$ssh_port${web_port:+, web :$web_port})"
    docker rm -f "$container" >/dev/null 2>&1 || true

    # Built as an array: an unquoted ${web_port:+-p ...} would rely on word
    # splitting and quote-removal inside the expansion, which is exactly the
    # kind of thing that silently publishes the wrong port.
    local publish=(-p "${ssh_port}:22")
    [ -n "$web_port" ] && publish+=(-p "${web_port}:${web_port}")

    docker run -d --name "$container" \
        "${publish[@]}" \
        -e DEV_PASSWORD="$DEV_PASSWORD" \
        -e HTTP_PROXY="${HTTP_PROXY:-}" -e HTTPS_PROXY="${HTTPS_PROXY:-}" -e NO_PROXY="${NO_PROXY:-}" \
        -e http_proxy="${HTTP_PROXY:-}" -e https_proxy="${HTTPS_PROXY:-}" -e no_proxy="${NO_PROXY:-}" \
        -v "${volume}:/home/dev/.cache" \
        --shm-size 1g \
        "$IMAGE" >/dev/null
    info "container $container, cache volume $volume"

    step "3/6  $ide: get in as the non-root dev user (via $TRANSPORT)"
    local ready=0 _
    for _ in $(seq 1 30); do
        if (exec 3<>"/dev/tcp/${LINK_HOST}/${ssh_port}") 2>/dev/null; then ready=1; break; fi
        sleep 1
    done
    [ "$ready" = 1 ] || die "nothing listening on ${LINK_HOST}:${ssh_port}; check: docker logs $container"
    info "ssh port $ssh_port open"

    ready=0
    for _ in $(seq 1 5); do
        if in_container "$ide" true 2>/dev/null; then ready=1; break; fi
        sleep 2
    done
    if [ "$ready" != 1 ]; then
        printf '\n'; docker logs "$container" 2>&1 | tail -10 | sed 's/^/      /'
        die "could not run commands in $container over $TRANSPORT"
    fi
    in_container "$ide" 'test "$(id -u)" -ne 0' || die "session is root - that must never happen"
    info "confirmed non-root: $(in_container "$ide" id -un | tr -d '\r')"

    # Give the IDE something to open. An empty project works but makes
    # first-start behaviour harder to read.
    in_container "$ide" 'test -n "$(ls -A /workspace 2>/dev/null)" || {
        mkdir -p /workspace/src
        printf "public class Main {\n    public static void main(String[] a) {\n        System.out.println(\"huddle poc\");\n    }\n}\n" > /workspace/src/Main.java
    }' || true

    step "4/6 + 5/6  $ide: install the IDE and its plugins"
    info "cold-start cost: IntelliJ ~1.5 GB, Rider ~2.2 GB, openvscode-server ~200 MB"
    in_container "$ide" "/usr/local/bin/install-ide.sh install $ide ${plugins[*]}" \
        || die "$ide install failed"

    step "6/6  $ide: start it and get a way in"
    in_container "$ide" "/usr/local/bin/install-ide.sh run $ide '$LINK_HOST' '$ssh_port'" \
        || die "$ide failed to start"

    if [ "$ide" = vscode ]; then
        printf '\n\033[1;32m================ OPEN THIS ================\033[0m\n\n'
        printf '    http://%s:%s/?folder=/workspace\n' "$LINK_HOST" "$web_port"
        printf '\n\033[1;32m===========================================\033[0m\n'
        info "no token (--without-connection-token), so anyone who can reach the port gets in"
        return 0
    fi

    info "waiting for the Gateway link (first boot indexes the project)"
    local link=""
    for _ in $(seq 1 90); do
        link=$(in_container "$ide" "grep -ohE 'jetbrains-gateway://[^[:space:]\"]+' ~/backend.log 2>/dev/null | tail -1" | tr -d '\r')
        [ -n "$link" ] && break
        if ! in_container "$ide" 'pgrep -f remote-dev-server >/dev/null' 2>/dev/null; then
            printf '\n'; in_container "$ide" 'tail -40 ~/backend.log' || true
            die "$ide backend exited before publishing a link (log above)"
        fi
        sleep 2
    done
    [ -n "$link" ] || { in_container "$ide" 'tail -40 ~/backend.log' || true; die "no link after 180s"; }

    # A key or password cannot go into the link - Gateway 2026.2 has no such
    # parameter (verified against its bytecode; see README). sshId, which it
    # does have, names a connection Gateway already saved.
    if [ -n "${SSH_ID:-}" ]; then
        link="${link}&sshId=$(printf '%s' "$SSH_ID" | sed 's/ /%20/g')"
        info "link bound to saved Gateway connection '$SSH_ID'"
    fi

    printf '\n\033[1;32m================ CONNECT WITH THIS ================\033[0m\n\n'
    printf '%s\n' "$link"
    printf '\n\033[1;32m===================================================\033[0m\n'
    info "protocol-handler link, not an http URL - paste into Win+R or Gateway"
    info "or connect Gateway over SSH: dev@$LINK_HOST:$ssh_port, password '${DEV_PASSWORD:-<empty>}',"
    info "leaving 'Specify private key' UNCHECKED (this image has PubkeyAuthentication no)"
}

# ---------------------------------------------------------------------------
target="$TARGET"

if [ "$target" = all ]; then
    for i in $ALL_IDES; do run_ide "$i"; done
    step "all done"
    printf '    %-10s %-28s %s\n' IDE CONNECT CONTAINER
    for i in $ALL_IDES; do
        if [ "$i" = vscode ]; then
            printf '    %-10s %-28s %s\n' "$i" "http://$LINK_HOST:$(ide_web_port "$i")/" "$(ide_container "$i")"
        else
            printf '    %-10s %-28s %s\n' "$i" "dev@$LINK_HOST:$(ide_ssh_port "$i")" "$(ide_container "$i")"
        fi
    done
    printf '\n'
    info "./run-poc.sh --links <ide>   to see the links again"
    info "./run-poc.sh --stop          to tear all three down"
else
    valid_ide "$target" || die "unknown ide '$target' (intellij|rider|vscode|all)"
    run_ide "$target" "$@"
    printf '\n'
    info "./run-poc.sh --links $target   to see the links again"
    info "./run-poc.sh --stop $target    to tear it down"
fi
