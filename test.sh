#!/usr/bin/env bash
set -euo pipefail

WORKSPACE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Vereisten controleren ==="
docker --version
node --version
npm --version

if ! command -v devcontainer &> /dev/null; then
  echo ""
  echo "=== @devcontainers/cli installeren ==="
  npm install -g @devcontainers/cli
fi

echo ""
echo "=== devcontainer starten ==="
devcontainer up --workspace-folder "$WORKSPACE_DIR"

echo ""
echo "=== node --version in container ==="
devcontainer exec --workspace-folder "$WORKSPACE_DIR" node --version

echo ""
echo "=== npm run hello in container ==="
devcontainer exec --workspace-folder "$WORKSPACE_DIR" npm run hello

echo ""
echo "=== draaiende containers ==="
docker ps --filter "label=devcontainer.local_folder=$WORKSPACE_DIR"

echo ""
echo "=== IntelliJ verbinden via ijdevc ==="

IJDEVC_DIR="$WORKSPACE_DIR/.ijdevc"
IJDEVC_ZIP="$IJDEVC_DIR/intellij-devcontainers-cli.zip"
IJDEVC_BIN="$IJDEVC_DIR/ijdevc/ijdevc"

mkdir -p "$IJDEVC_DIR"

if [ ! -f "$IJDEVC_BIN" ]; then
  echo "ijdevc downloaden..."
  # direct URL — jb.gg short-link redirect naar JetBrains homepage en werkt niet met curl
  IJDEVC_URL="https://download.jetbrains.com/resources/intellij/dev-containers/243.19420.43/intellij-devcontainers-cli.zip"
  curl -f -L -o "$IJDEVC_ZIP" "$IJDEVC_URL"
  unzip -o "$IJDEVC_ZIP" -d "$IJDEVC_DIR"
  chmod +x "$IJDEVC_BIN"
fi

echo "IntelliJ starten in devcontainer..."

# ijdevc 243.x gebruikt Docker API v1.24; Docker 29+ vereist minimaal v1.41 (IJPL-217878).
# Wrap in subshell zodat een fout het testscript niet afbreekt.
(
  set +e

  # Zoek JAVA_HOME als niet gezet
  if [ -z "${JAVA_HOME:-}" ] || [ ! -f "$JAVA_HOME/bin/java" ]; then
    JAVA_HOME=$(find "$HOME/.jdks" -maxdepth 2 -name "java" -path "*/bin/java" 2>/dev/null | sort -r | head -1 | sed 's|/bin/java||')
    if [ -z "$JAVA_HOME" ]; then
      echo "WAARSCHUWING: Geen JDK gevonden in $HOME/.jdks — stel JAVA_HOME handmatig in." >&2
      exit 0
    fi
    echo "JAVA_HOME: $JAVA_HOME"
  fi

  # ijdevc zoekt Docker via unix socket — Rancher Desktop gebruikt een Windows named pipe
  JAVA_HOME="$JAVA_HOME" \
  DOCKER_HOST="npipe:////./pipe/docker_engine" \
  DOCKER_API_VERSION="1.41" \
  "$IJDEVC_BIN" \
    --config "$WORKSPACE_DIR/.devcontainer/devcontainer.json" \
    "$WORKSPACE_DIR"

  rc=$?
  if [ $rc -ne 0 ]; then
    echo "WAARSCHUWING: ijdevc afgesluiten met code $rc"
    echo "Zie https://youtrack.jetbrains.com/issue/IJPL-217878 (Docker 29+ API v1.41 vs ijdevc v1.24)"
  fi
)
