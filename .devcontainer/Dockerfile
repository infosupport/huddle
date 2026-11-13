# Devcontainer-image voor gebruik binnen een bestaande Huddle.
#
# Gebaseerd op de WebStorm base-devimage (die erft van base-devimage: AI-agents,
# configuratie, Node 24, docker CLI). Bouw die eerst lokaal vanuit de repo-root:
#   docker build -t base-devimage-webstorm -f base-devimage-webstorm/Dockerfile .
#
# De base-image draait standaard als `vscode` en heeft sudo al gestript. De
# container zelf blijft root-capable (zie `user: root` in docker-compose.yml) zodat
# de devcontainer-bootstrap (JetBrains Gateway) de workspace naar de dev-user kan
# chownen — dat gebeurt via een root-exec en heeft CAP_CHOWN nodig. "Geen root
# access" geldt voor de agent: die draait als `vscode` (remoteUser) zonder sudo.
FROM base-devimage-webstorm

# Terug naar root zodat pid 1 root-capable is (de base eindigt op USER vscode).
USER root
