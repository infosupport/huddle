#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${HUDDLE_IMAGE:-huddle}"
CONTAINER_NAME="${HUDDLE_CONTAINER:-huddle}"
BUILD_CONTEXT="${HUDDLE_BUILD_CONTEXT:-./gateway}"

HOST_PORT="${HUDDLE_PORT:-3000}"
CONTAINER_PORT="3000"

# De management-API/UI heeft geen eigen authenticatie; toegang leunt op
# netwerkpositie. Publiceer daarom standaard alléén op de loopback zodat de
# admin-API niet op het LAN bereikbaar is. Zet HUDDLE_BIND_ADDR bewust op
# 0.0.0.0 als je hem breder wilt blootstellen (op eigen risico).
HUDDLE_BIND_ADDR="${HUDDLE_BIND_ADDR:-127.0.0.1}"

VOLUME_NAME="${HUDDLE_VOLUME:-huddle-data}"

INTERNAL_NETWORK="${HUDDLE_INTERNAL_NETWORK:-devcontainer-net}"
BRIDGE_NETWORK="${HUDDLE_BRIDGE_NETWORK:-bridge}"

if [ -n "${MSYSTEM:-}" ]; then
  # Git Bash / MSYS op Windows: voorkom verkeerde path-conversie
  DOCKER_SOCK="${DOCKER_SOCK:-//var/run/docker.sock}"
else
  DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
fi

DC_SOCKETS="${DC_SOCKETS:-/tmp/dc-sockets}"

echo "==> Build image: ${IMAGE_NAME}"
docker build "${BUILD_CONTEXT}" -t "${IMAGE_NAME}"

echo "==> Zorg dat volume bestaat: ${VOLUME_NAME}"
docker volume inspect "${VOLUME_NAME}" >/dev/null 2>&1 || \
  docker volume create "${VOLUME_NAME}"

echo "==> Zorg dat internal netwerk bestaat: ${INTERNAL_NETWORK}"
docker network inspect "${INTERNAL_NETWORK}" >/dev/null 2>&1 || \
  docker network create --internal "${INTERNAL_NETWORK}"

echo "==> Zorg dat socket directory bestaat: ${DC_SOCKETS}"
mkdir -p "${DC_SOCKETS}"

echo "==> Verwijder oude container als die bestaat: ${CONTAINER_NAME}"
docker rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true

MOUNTS=(
  "-v" "${VOLUME_NAME}:/data"
  "-v" "${DOCKER_SOCK}:/var/run/docker.sock"
  "-v" "${DC_SOCKETS}:/tmp/dc-sockets"
)

add_readonly_mount_if_exists() {
  local source="$1"
  local target="$2"

  if [ -d "${source}" ]; then
    MOUNTS+=("-v" "$(pwd)/${source}:${target}:ro")
  else
    echo "Waarschuwing: ${source} bestaat niet, mount wordt overgeslagen"
  fi
}

add_readonly_mount_if_exists "./base-devimage-rider" "/base-devimage-rider"
add_readonly_mount_if_exists "./base-devimage-intellij" "/base-devimage-intellij"
add_readonly_mount_if_exists "./base-devimage-vscode" "/base-devimage-vscode"

echo "==> Start container op internal netwerk"
docker run -d \
  --name "${CONTAINER_NAME}" \
  --network "${INTERNAL_NETWORK}" \
  -p "${HUDDLE_BIND_ADDR}:${HOST_PORT}:${CONTAINER_PORT}" \
  "${MOUNTS[@]}" \
  "${IMAGE_NAME}"

echo "==> Verbind container met bridge netwerk"
if docker network inspect "${BRIDGE_NETWORK}" >/dev/null 2>&1; then
  docker network connect "${BRIDGE_NETWORK}" "${CONTAINER_NAME}" || true
else
  echo "Waarschuwing: netwerk ${BRIDGE_NETWORK} bestaat niet, bridge connect wordt overgeslagen"
fi

echo
echo "Klaar."
echo "Container: ${CONTAINER_NAME}"
echo "URL: http://localhost:${HOST_PORT}"