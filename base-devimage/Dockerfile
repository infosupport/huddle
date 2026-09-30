FROM mcr.microsoft.com/devcontainers/base:debian

# mcr base levert al: vscode user (uid 1000) — passwordless sudo wordt hieronder verwijderd,
# zsh + oh-my-zsh, git, curl, wget, common-utils.

# Docker apt repo + iptables (NAT-rule huddle) + Docker CLI + compose plugin.
# openssh-server + the JetBrains Rider runtime libs (libicu76/libssl3/zlib1g/
# libstdc++6/libgssapi-krb5-2) are baked in here too: they are OS packages the
# runtime-installed JB/VS Code backend (install-ide.sh, run per devcontainer
# start) cannot bring with it, unlike the backend itself which is fetched at
# runtime so image rebuilds aren't needed for every IDE/plugin change.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg \
        inotify-tools \
        iptables \
        openssh-server \
        libicu76 \
        libssl3 \
        zlib1g \
        libstdc++6 \
        libgssapi-krb5-2 \
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

# Global CLIs (npm). claude-code niet meer via npm: zie native installer onderaan.
RUN npm install -g @openai/codex @github/copilot opencode-ai

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

# sshd hardening, static config only. No host keys baked in here (generated at
# container-start time, see docker.ts's SSHD_BOOTSTRAP) and no sshd started
# here either — pid 1 is a dummy sleep loop (docker.ts's createAndStartContainer),
# real setup happens via a root `docker exec` after start.
RUN mkdir -p /etc/ssh/sshd_config.d \
    && printf '%s\n' \
        'PubkeyAuthentication yes' \
        'PasswordAuthentication no' \
        'KbdInteractiveAuthentication no' \
        'ChallengeResponseAuthentication no' \
        'PermitRootLogin no' \
        'AllowUsers vscode' \
        'PermitUserEnvironment no' \
        > /etc/ssh/sshd_config.d/10-huddle.conf

# Draai als non-root. Root-only setup (iptables NAT) doet de spawn-flow via een
# aparte `docker exec -u root` (zie huddle.ps1), dus pid 1 hoeft geen root te zijn.
USER vscode

# Claude Code via de officiële native installer i.p.v. npm: kleinere image
# (geen gebundelde node_modules) en de binary update zichzelf. Installeert als
# de vscode-user naar /home/vscode/.local/bin/claude.
# Pinnen kan met `| bash -s <versie>` (bijv. `stable` of een versienummer).
ENV PATH="/home/vscode/.local/bin:${PATH}"
RUN curl -fsSL https://claude.ai/install.sh | bash
