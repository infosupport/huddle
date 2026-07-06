FROM ghcr.io/infosupport/base-devimage

# Voor VS Code hoeft er hier GEEN backend geïnstalleerd te worden. VS Code installeert
# zijn eigen "VS Code Server" automatisch in de container zodra je via de Dev Containers-
# extensie attached ("Attach to Running Container").

LABEL com.devcontainer.snapshot=true
LABEL com.devcontainer.source=base-devimage-vscode
LABEL com.devcontainer.ide=vscode

# Geen ENTRYPOINT/CMD override — huddle's spawn-flow zet die zelf.
