FROM mcr.microsoft.com/devcontainers/base:debian

# mcr base levert al: vscode user (uid 1000) met passwordless sudo,
# zsh + oh-my-zsh, git, curl, wget, common-utils. Voor Rider download
# JB Gateway zelf de .NET-runtime in de RemoteDev-dist; als je dotnet
# ook in je terminal wil, voeg dan apt-install dotnet-sdk-8.0 toe.

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

# markitdown: converteert PDF/Office/HTML/afbeeldingen → Markdown.
# Wordt gebruikt door de markitdown-skill (.ai/claude/skills/markitdown.md).
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && pip install --break-system-packages 'markitdown[all]' \
    && rm -rf /var/lib/apt/lists/*

# Standaard AI-config per provider (zie ../.ai). Legt elke agent uit dat hij in
# een Huddle DMZ-devcontainer draait. Build-context is de repo-root (zie huddle.ps1
# + .dockerignore) zodat deze COPY bij .ai/ kan. Dirs eerst vscode-owned maken
# zodat de tools hun eigen state ernaast kunnen schrijven.
RUN mkdir -p /home/vscode/.claude/agents /home/vscode/.claude/skills /home/vscode/.codex /home/vscode/.config/opencode/agents /home/vscode/.ai/mcp \
    && chown -R vscode:vscode /home/vscode/.claude /home/vscode/.codex /home/vscode/.config /home/vscode/.ai
COPY --chown=vscode:vscode .ai/claude/CLAUDE.md             /home/vscode/.claude/CLAUDE.md
COPY --chown=vscode:vscode .ai/claude/settings.json         /home/vscode/.claude/settings.json
COPY --chown=vscode:vscode .ai/claude/statusline-command.sh /home/vscode/.claude/statusline-command.sh
COPY --chown=vscode:vscode .ai/claude/agents/               /home/vscode/.claude/agents/
COPY --chown=vscode:vscode .ai/claude/skills/               /home/vscode/.claude/skills/
COPY --chown=vscode:vscode .ai/codex/AGENTS.md              /home/vscode/.codex/AGENTS.md
COPY --chown=vscode:vscode .ai/opencode/AGENTS.md           /home/vscode/.config/opencode/AGENTS.md
COPY --chown=vscode:vscode .ai/opencode/opencode.json       /home/vscode/.config/opencode/opencode.json
COPY --chown=vscode:vscode .ai/opencode/agents/             /home/vscode/.config/opencode/agents/
COPY --chown=vscode:vscode .ai/mcp/mcp.json                 /home/vscode/.ai/mcp/mcp.json
RUN chmod +x /home/vscode/.claude/statusline-command.sh

# vscode user lid maken van docker group (mcr base zet hem er niet automatisch in)
RUN groupadd -f docker && usermod -aG docker vscode

LABEL com.devcontainer.snapshot=true
LABEL com.devcontainer.source=base-devimage-rider
LABEL com.devcontainer.ide=rider

# Geen USER/ENTRYPOINT/CMD override — huddle's spawn-flow zet die zelf.
# Default upstream USER is root, wat aansluit bij wat de werkende JB-snapshot
# (empty2) had: pid 1 als root i.p.v. vscode.
