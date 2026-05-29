FROM mcr.microsoft.com/devcontainers/base:debian

# mcr base levert al: vscode user (uid 1000) met passwordless sudo,
# zsh + oh-my-zsh, git, curl, wget, common-utils. Voor IntelliJ download
# JB Gateway zelf de JBR/JDK in de RemoteDev-dist; als je `java`/`mvn`
# ook in je terminal wil, voeg dan apt-install temurin-21-jdk maven toe.

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

# vscode user lid maken van docker group (mcr base zet hem er niet automatisch in)
RUN groupadd -f docker && usermod -aG docker vscode

LABEL com.devcontainer.snapshot=true
LABEL com.devcontainer.source=base-devimage-intellij
LABEL com.devcontainer.ide=intellij

# Geen USER/ENTRYPOINT/CMD override — huddle's spawn-flow zet die zelf.
# Default upstream USER is root.
