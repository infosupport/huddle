FROM mcr.microsoft.com/devcontainers/base:debian

# mcr base levert al: vscode user (uid 1000) — passwordless sudo wordt hieronder verwijderd,
# zsh + oh-my-zsh, git, curl, wget, common-utils.

# Docker apt repo + iptables (NAT-rule huddle) + Docker CLI + compose plugin
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        inotify-tools \
        iptables \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Node.js 24 (vereist voor claude-code, codex en copilot CLIs)
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Global CLIs
RUN npm install -g @anthropic-ai/claude-code @openai/codex @github/copilot opencode-ai 

# markitdown: converteert PDF/Office/HTML/afbeeldingen → Markdown.
# Wordt gebruikt door de markitdown-skill (.ai/claude/skills/markitdown.md).
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && pip install --break-system-packages 'markitdown[all]' \
    && rm -rf /var/lib/apt/lists/*

# Mappen aanmaken voor AI CLI-tools. Inhoud wordt bij container-start
# via de instelbare folder mappings (Huddle Instellingen) gemount.
RUN mkdir -p /home/vscode/.claude/agents /home/vscode/.claude/skills \
             /home/vscode/.codex /home/vscode/.copilot \
             /home/vscode/.config/opencode/agents \
             /home/vscode/.ai/mcp \
    && chown -R vscode:vscode /home/vscode/.claude /home/vscode/.codex \
                              /home/vscode/.copilot /home/vscode/.config \
                              /home/vscode/.ai

# Verwijder sudo-rechten van vscode (mcr base geeft ze standaard, wij willen dit niet)
RUN gpasswd -d vscode sudo 2>/dev/null || true \
    && find /etc/sudoers.d -name '*vscode*' -delete 2>/dev/null || true

# vscode user lid maken van docker group (mcr base zet hem er niet automatisch in)
RUN groupadd -f docker && usermod -aG docker vscode

# Draai als non-root. Root-only setup (iptables NAT) doet de spawn-flow via een
# aparte `docker exec -u root` (zie huddle.ps1), dus pid 1 hoeft geen root te zijn.
USER vscode
