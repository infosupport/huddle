FROM mcr.microsoft.com/devcontainers/base:debian

# mcr base levert al: vscode user (uid 1000) met passwordless sudo,
# zsh + oh-my-zsh, git, curl, wget, common-utils.
#
# Belangrijk verschil met de JetBrains-varianten: voor VS Code hoeft er hier
# GEEN backend geïnstalleerd te worden. VS Code installeert zijn eigen
# "VS Code Server" automatisch in de container zodra je via de Dev Containers-
# extensie attached ("Attach to Running Container"). Dus geen RemoteDev-dist,
# geen JBR/.NET-runtime, geen host-config.

# Docker apt repo + iptables (NAT-rule huddle) + Docker CLI + compose plugin
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        iptables \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 (vereist voor claude-code en codex CLIs)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Global CLIs
RUN npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai

# Standaard AI-config per provider (zie ../.ai). Legt elke agent uit dat hij in
# een Huddle DMZ-devcontainer draait. Build-context is de repo-root (zie huddle.ps1
# + .dockerignore) zodat deze COPY bij .ai/ kan. Dirs eerst vscode-owned maken
# zodat de tools hun eigen state ernaast kunnen schrijven.
RUN mkdir -p /home/vscode/.claude /home/vscode/.codex /home/vscode/.config/opencode /home/vscode/.ai/mcp \
    && chown -R vscode:vscode /home/vscode/.claude /home/vscode/.codex /home/vscode/.config /home/vscode/.ai
COPY --chown=vscode:vscode .ai/claude/CLAUDE.md   /home/vscode/.claude/CLAUDE.md
COPY --chown=vscode:vscode .ai/codex/AGENTS.md    /home/vscode/.codex/AGENTS.md
COPY --chown=vscode:vscode .ai/opencode/AGENTS.md /home/vscode/.config/opencode/AGENTS.md
COPY --chown=vscode:vscode .ai/mcp/mcp.json       /home/vscode/.ai/mcp/mcp.json

# vscode user lid maken van docker group (mcr base zet hem er niet automatisch in)
RUN groupadd -f docker && usermod -aG docker vscode

LABEL com.devcontainer.snapshot=true
LABEL com.devcontainer.source=base-devimage-vscode
LABEL com.devcontainer.ide=vscode

# Geen USER/ENTRYPOINT/CMD override — huddle's spawn-flow zet die zelf.
