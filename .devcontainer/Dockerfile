# Devcontainer-image voor gebruik binnen een bestaande Huddle.
#
# De container is bewust root-capable zodat de devcontainer-bootstrap (JetBrains
# Gateway / VS Code) de workspace naar de dev-user kan chownen — dat gebeurt via
# een root-exec en heeft CAP_CHOWN nodig. "Geen root access" wordt hier NIET
# afgedwongen door de container te ontmachtigen (dat brak de bootstrap met
# `chown: Operation not permitted`), maar door de dev/agent-user non-root te maken
# en zijn sudo-rechten te strippen — exact zoals de Huddle base-images doen.
FROM mcr.microsoft.com/devcontainers/javascript-node:1-22-bookworm

# Strip sudo van de non-root `node`-user: geen wachtwoordloze escalatie, geen
# sudoers-drop-ins. De agent draait als `node` (remoteUser) en kan geen root worden.
RUN gpasswd -d node sudo 2>/dev/null || true \
    && find /etc/sudoers.d -type f -delete 2>/dev/null || true \
    && (command -v sudo >/dev/null 2>&1 && apt-get purge -y sudo >/dev/null 2>&1 || true) \
    && rm -rf /var/lib/apt/lists/*
