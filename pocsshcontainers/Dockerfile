# POC: one slim SSH container, no IDE baked in.
#
# The IDE is NOT part of this image. IntelliJ IDEA, Rider or OpenVSCode Server
# get downloaded and installed at runtime by install-ide.sh. That is the whole
# point: one slim base instead of the base-devimage-{intellij,rider,vscode}
# matrix.

FROM debian:trixie-slim

ARG DEV_USER=dev
ARG DEV_UID=1000

# ---------------------------------------------------------------------------
# Layer 1: what the JetBrains remote-dev backend needs from the OS.
#
# JetBrains' docs list libxext/libxrender/libxtst/libxi/freetype as dev
# container prerequisites, but as of 2026.2 that list is stale: the backend
# ships its own copies in plugins/remote-dev-server/selfcontained/lib and uses
# them by default. Its launcher.sh says so literally:
#
#   # Patch JBR to make self-contained JVM (requires nothing from host
#   # system except glibc)
#
# So we install glibc (from the base image) plus only the tools the launcher
# shells out to. Verified against idea-2026.2.2 (build IU-262.10315.125).
#
# If you ever set REMOTE_DEV_SERVER_USE_SELF_CONTAINED_LIBS=0, add back:
#   libxext6 libxrender1 libxtst6 libxi6 libfreetype6 libfontconfig1
# ---------------------------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        openssh-server \
        ca-certificates \
        curl \
        tar \
        gzip \
        procps \
        git \
    ; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Layer 2: Rider.
#
# Rider bundles its own .NET, but .NET links dynamically against the OS's ICU,
# OpenSSL and zlib. Without these the Rider backend starts and then dies when
# ReSharper's out-of-process host boots - which looks like a backend crash
# rather than a missing library.
#
# One image serves all three IDEs, so these are always installed. Costs ~40 MB.
# NOT yet verified against a running Rider backend - see README.
# ---------------------------------------------------------------------------
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        libicu76 \
        libssl3 \
        zlib1g \
        libstdc++6 \
        libgssapi-krb5-2 \
    ; \
    rm -rf /var/lib/apt/lists/*

# ---------------------------------------------------------------------------
# Non-root developer account. No sudo, in no admin group. The backend forks
# the developer's shell, so a root backend == a root developer session.
# ---------------------------------------------------------------------------
RUN set -eux; \
    useradd --uid "$DEV_UID" --create-home --shell /bin/bash "$DEV_USER"; \
    mkdir -p /workspace; \
    chown "$DEV_USER":"$DEV_USER" /workspace

# ---------------------------------------------------------------------------
# SSH. sshd itself runs as root (it has to, to own port 22 and manage the
# session); logging in as root is disabled and only $DEV_USER may connect.
#
# THERE IS NO KEY AUTH. Password only, so nothing has to move a key file
# between the container, WSL and the host - which is where every connection
# problem in this POC came from. run-poc.sh does not generate a keypair and
# the image never receives one.
#
# LOCAL POC ONLY. A well-known (or blank) password on an SSH server is fine
# while the port is published to localhost on one developer machine and
# nothing else. A Huddle sandbox reachable from anywhere else must go back to
# key-only auth: drop the three Password/Kbd/PermitEmpty lines below, set
# PubkeyAuthentication yes, and inject the per-sandbox public key.
#
# PerSourcePenalties (OpenSSH >= 9.8) rate-limits a source IP after failed
# auth attempts. A provisioning script polling for readiness looks exactly
# like an attacker, gets penalised, and then cannot connect even once its
# credentials are right. Appended only if this sshd knows the keyword, since
# sshd refuses to start on an unknown one.
#
# Host keys are deliberately NOT generated here - baking them in would give
# every container the same identity. The entrypoint makes them on first boot;
# the pair created for `sshd -t` is thrown away.
# ---------------------------------------------------------------------------
RUN set -eux; \
    mkdir -p /run/sshd; \
    conf=/etc/ssh/sshd_config.d/poc.conf; \
    printf '%s\n' \
        'PermitRootLogin no' \
        'PubkeyAuthentication no' \
        'PasswordAuthentication yes' \
        'KbdInteractiveAuthentication yes' \
        'PermitEmptyPasswords yes' \
        "AllowUsers ${DEV_USER}" \
        'AllowTcpForwarding yes' \
        'PermitTTY yes' \
        'X11Forwarding no' \
        'PrintMotd no' \
        'AcceptEnv HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy' \
        'PerSourcePenalties no' \
        > "$conf"; \
    ssh-keygen -A >/dev/null; \
    if ! sshd -t 2>/dev/null; then \
        echo 'note: sshd rejected PerSourcePenalties, removing it'; \
        sed -i '/PerSourcePenalties/d' "$conf"; \
    fi; \
    sshd -t; \
    rm -f /etc/ssh/ssh_host_*

COPY install-ide.sh /usr/local/bin/install-ide.sh
COPY entrypoint.sh   /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/install-ide.sh /usr/local/bin/entrypoint.sh

# Cache dir, pre-owned by $DEV_USER so a mounted volume does not come up
# root-owned - the #1 silent-failure cause here.
RUN set -eux; \
    mkdir -p "/home/${DEV_USER}/.cache"; \
    chown -R "$DEV_USER":"$DEV_USER" "/home/${DEV_USER}/.cache"

ENV DEV_USER=${DEV_USER}

# 22 = SSH (published on a per-IDE port by run-poc.sh)
# 3000 = OpenVSCode Server, when the vscode flow is used
EXPOSE 22 3000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
