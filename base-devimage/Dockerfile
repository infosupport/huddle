FROM debian:bookworm-slim

# system tools + Docker apt repo
RUN apt-get update && apt-get install -y \
        ca-certificates \
        curl \
        git \
        gnupg \
        iptables \
        procps \
        wget \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
       > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*

# Node.js 22 via NodeSource (required for claude-code and codex CLIs)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Global CLIs: Anthropic Claude Code and OpenAI Codex
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Create vscode user and grant docker socket access via docker group membership
RUN groupadd --gid 1000 vscode \
    && useradd --uid 1000 --gid 1000 --shell /bin/bash --create-home vscode \
    && groupadd -f docker \
    && usermod -aG docker vscode

LABEL com.devcontainer.snapshot=true
LABEL com.devcontainer.source=base-devimage

USER vscode

ENTRYPOINT ["/bin/sh"]
CMD ["-c", "while sleep 1000; do :; done"]
