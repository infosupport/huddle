import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import { createContainerProxy } from './socket-proxy';
import { saveCredentials, getSetting, listFolderMappings } from './db';
import { getCaCertPem } from './tls-ca';
import { ensureWorktree } from './worktree';
import { sanitizeResolvConf } from './dns-egress';

const SOCKET_DIR = '/tmp/dc-sockets';

// De CLI geeft de gedetecteerde container-engine door via HUDDLE_RUNTIME. Bij
// (rootless) Podman is de per-container proxy-socket SELinux-gelabeld; een
// SELinux-confined devcontainer mag hem dan niet benaderen. `label=disable` op
// de devcontainer heft die confinement op zodat DOCKER_HOST/de socket werken.
// (Docker/Docker Desktop hebben dit niet nodig.)
const CONTAINER_RUNTIME = process.env.HUDDLE_RUNTIME ?? 'docker';
const RUNTIME_SECURITY_OPT: string[] = CONTAINER_RUNTIME === 'podman' ? ['label=disable'] : [];

// ── IP → container name cache (used by proxy) ────────────────────────────────

const CACHE_TTL_MS = 10_000;
let ipToName = new Map<string, string>();
let cacheExpiry = 0;

// ── Generic Docker socket helpers ────────────────────────────────────────────

export function dockerRequest(method: string, path: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      socketPath: '/var/run/docker.sock',
      method,
      path,
      headers: bodyStr ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) } : {},
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk: string) => (raw += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Docker API ${method} ${path} → ${res.statusCode}: ${raw}`));
          return;
        }
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve(raw);
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── IP resolution (proxy use) ────────────────────────────────────────────────

async function fetchContainerMap(): Promise<Map<string, string>> {
  const containers: any[] = await dockerRequest('GET', '/containers/json');
  const map = new Map<string, string>();
  for (const c of containers) {
    const name = ((c.Names?.[0] as string) ?? '').replace(/^\//, '');
    // Child containers inherit their parent's allowlist: map their IP to the
    // parent container name so proxy rule lookups use the parent's rules.
    const parentName = (c.Labels?.['huddle.parent'] as string | undefined) ?? name;
    for (const net of Object.values<any>(c.NetworkSettings?.Networks ?? {})) {
      if (net.IPAddress) map.set(net.IPAddress, parentName);
    }
  }
  return map;
}

export async function resolveContainerByIp(rawIp: string): Promise<string | null> {
  const ip = rawIp.replace(/^::ffff:/, '');
  const now = Date.now();
  if (now > cacheExpiry) {
    try {
      ipToName = await fetchContainerMap();
      cacheExpiry = now + CACHE_TTL_MS;
    } catch {
      cacheExpiry = now + 2_000;
    }
  }
  return ipToName.get(ip) ?? null;
}

// ── Management functions ─────────────────────────────────────────────────────

export interface DevcontainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  workspacePath: string;
  presentableName: string;
  created: number;
  inNetwork: boolean;
  huddleInNetwork: boolean;
}

// Set van dc-net-* netwerken waar de huddle-container zelf in zit. Wordt
// gebruikt om per devcontainer te detecteren of huddle nog aan zijn dc-net is
// gekoppeld (na een herstart van de container kan deze koppeling sneuvelen
// als het netwerk opnieuw is aangemaakt).
export async function getHuddleNetworks(): Promise<Set<string>> {
  try {
    const inspect = await dockerRequest('GET', '/containers/huddle/json');
    const nets = inspect?.NetworkSettings?.Networks ?? {};
    return new Set(Object.keys(nets));
  } catch {
    return new Set();
  }
}

export async function listDevcontainers(): Promise<DevcontainerInfo[]> {
  const filters = JSON.stringify({ label: ['com.intellij.devcontainer.id'] });
  const [containers, huddleNets] = await Promise.all([
    dockerRequest('GET', `/containers/json?all=1&filters=${encodeURIComponent(filters)}`) as Promise<any[]>,
    getHuddleNetworks(),
  ]);
  return containers.map((c) => {
    const name = ((c.Names?.[0] as string) ?? '').replace(/^\//, '');
    const netName = `dc-net-${name}`;
    const dcNet = c.NetworkSettings?.Networks?.[netName] ?? c.NetworkSettings?.Networks?.['devcontainer-net'];
    return {
      id: c.Id,
      name,
      image: c.Image,
      status: c.Status,
      workspacePath: c.Labels?.['com.intellij.devcontainer.sources.path'] ?? '',
      presentableName: c.Labels?.['com.intellij.devcontainer.presentable.name'] ?? '',
      created: c.Created,
      inNetwork: Boolean(dcNet?.IPAddress),
      huddleInNetwork: huddleNets.has(netName),
    };
  });
}

export async function refreshContainerIptables(containerId: string, containerName: string): Promise<void> {
  // After a huddle restart the container's iptables rules still point to the old huddle IP.
  // Rebuild both the nat DNAT rule and the filter DROP rules with the new huddle IP.
  const script = `
HUDDLE_IP=$(getent hosts huddle 2>/dev/null | awk '{print $1}')
[ -z "$HUDDLE_IP" ] && exit 0
iptables -t nat -L OUTPUT --line-numbers -n 2>/dev/null \
  | awk '/DNAT.*dpt:80/{print $1}' | sort -rn \
  | while read LINE; do iptables -t nat -D OUTPUT "$LINE" 2>/dev/null || true; done
iptables -t nat -A OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80" 2>/dev/null || true
iptables -F OUTPUT 2>/dev/null || true
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -p tcp -d "$HUDDLE_IP" -j ACCEPT
iptables -A OUTPUT -p tcp -j DROP
`;
  try {
    const exec = await dockerRequest('POST', `/containers/${encodeURIComponent(containerId)}/exec`, {
      User: 'root',
      Cmd: ['sh', '-c', script],
      AttachStdout: false,
      AttachStderr: false,
    });
    await dockerRequest('POST', `/exec/${exec.Id}/start`, { Detach: true });
    console.log(`[iptables] refreshed rules in ${containerName}`);
  } catch (err: any) {
    console.warn(`[iptables] refresh failed for ${containerName}:`, err.message);
  }
}

export type IdeName = 'rider' | 'intellij' | 'vscode';

export function isIdeName(value: unknown): value is IdeName {
  return value === 'rider' || value === 'intellij' || value === 'vscode';
}

export function getBaseImageName(ide: IdeName): string {
  const envKey = `BASE_IMAGE_${ide.toUpperCase()}`;
  return process.env[envKey] ?? `ghcr.io/infosupport/base-devimage-${ide}`;
}

export async function inspectContainer(name: string): Promise<any> {
  return dockerRequest('GET', `/containers/${encodeURIComponent(name)}/json`);
}

export interface SnapshotImage {
  id: string;
  name: string;
  size: number;
  created: number;
  ide?: IdeName;
}

export async function listSnapshotImages(ide?: IdeName): Promise<SnapshotImage[]> {
  const labelFilters = ['com.devcontainer.snapshot=true'];
  if (ide) labelFilters.push(`com.devcontainer.ide=${ide}`);
  const filters = JSON.stringify({ label: labelFilters });
  const images: any[] = await dockerRequest('GET', `/images/json?filters=${encodeURIComponent(filters)}`);
  return images.map((img) => {
    const labels: Record<string, string> = img.Labels ?? {};
    const labelIde = labels['com.devcontainer.ide'];
    return {
      id: img.Id,
      name: (img.RepoTags?.[0] as string) ?? img.Id.substring(7, 19),
      size: img.Size,
      created: img.Created,
      ide: isIdeName(labelIde) ? labelIde : undefined,
    };
  });
}

// Read the IDE that a running container is configured for, by parsing the JB
// devcontainer model label (`customizations.jetbrains.backend`).
function ideFromContainerLabels(labels: Record<string, string> | undefined): IdeName | undefined {
  const raw = labels?.['com.intellij.devcontainer.model'];
  if (!raw) return undefined;
  try {
    const backend = JSON.parse(raw)?.customizations?.jetbrains?.backend;
    if (backend === 'Rider') return 'rider';
    if (backend === 'IntelliJ') return 'intellij';
  } catch { /* fallthrough */ }
  return undefined;
}

export async function execContainerOutput(containerId: string, cmd: string[]): Promise<string> {
  const execCreate = await dockerRequest('POST', `/containers/${encodeURIComponent(containerId)}/exec`, {
    AttachStdout: true,
    AttachStderr: false,
    Tty: false,
    Cmd: cmd,
    User: 'root',
  });
  return new Promise((resolve, reject) => {
    const startBody = JSON.stringify({ Detach: false, Tty: false });
    const req = http.request(
      {
        socketPath: '/var/run/docker.sock',
        method: 'POST',
        path: `/exec/${execCreate.Id}/start`,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(startBody) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          // Docker multiplexed stream: 8-byte header [type,0,0,0, size(4 BE)] + payload
          let stdout = '';
          let offset = 0;
          while (offset + 8 <= raw.length) {
            const streamType = raw[offset];
            const size = raw.readUInt32BE(offset + 4);
            offset += 8;
            if (offset + size > raw.length) break;
            if (streamType === 1) stdout += raw.subarray(offset, offset + size).toString('utf8');
            offset += size;
          }
          resolve(stdout);
        });
      },
    );
    req.on('error', reject);
    req.write(startBody);
    req.end();
  });
}

export async function commitContainer(containerId: string, imageName: string): Promise<string> {
  const [repo, tag = 'latest'] = imageName.split(':');
  // Inherit the IDE label from the source container so the snapshot is filterable per IDE.
  const inspect = await inspectContainer(containerId);
  const sourceIde = ideFromContainerLabels(inspect?.Config?.Labels);
  const labels: Record<string, string> = {
    'com.devcontainer.snapshot': 'true',
    'com.devcontainer.source': containerId,
    'com.devcontainer.created': new Date().toISOString(),
  };
  if (sourceIde) labels['com.devcontainer.ide'] = sourceIde;
  const result = await dockerRequest(
    'POST',
    `/commit?container=${encodeURIComponent(containerId)}&repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
    { Labels: labels }
  );
  return result.Id ?? '';
}

export async function listNetworks(): Promise<any[]> {
  return dockerRequest('GET', '/networks');
}

export async function networkExists(name: string): Promise<boolean> {
  try {
    await dockerRequest('GET', `/networks/${encodeURIComponent(name)}`);
    return true;
  } catch {
    return false;
  }
}

export async function createNetwork(name: string): Promise<void> {
  await dockerRequest('POST', '/networks/create', { Name: name, Internal: true });
}

export async function imageExists(name: string): Promise<boolean> {
  try {
    await dockerRequest('GET', `/images/${encodeURIComponent(name)}/json`);
    return true;
  } catch {
    return false;
  }
}

export async function buildImage(imageName: string, dockerfilePath: string): Promise<void> {
  const dockerfileContent = fs.readFileSync(dockerfilePath);
  // Minimal single-file tar: just the Dockerfile.
  const header = Buffer.alloc(512);
  Buffer.from('Dockerfile').copy(header, 0);
  Buffer.from('0000644\0').copy(header, 100);
  Buffer.from('0000000\0').copy(header, 108);
  Buffer.from('0000000\0').copy(header, 116);
  Buffer.from(dockerfileContent.length.toString(8).padStart(11, '0') + '\0').copy(header, 124);
  Buffer.from(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0').copy(header, 136);
  header[156] = 0x30;
  Buffer.from('ustar\0').copy(header, 257);
  Buffer.from('00').copy(header, 263);
  Buffer.from('        ').copy(header, 148);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ').copy(header, 148);
  const padded = Buffer.alloc(Math.ceil(dockerfileContent.length / 512) * 512);
  dockerfileContent.copy(padded);
  const tarData = Buffer.concat([header, padded, Buffer.alloc(1024)]);

  await new Promise<void>((resolve, reject) => {
    const options: http.RequestOptions = {
      socketPath: '/var/run/docker.sock',
      method: 'POST',
      path: `/build?t=${encodeURIComponent(imageName)}`,
      headers: {
        'content-type': 'application/x-tar',
        'content-length': tarData.length,
      },
    };
    const req = http.request(options, (res) => {
      let output = '';
      res.on('data', (chunk: string) => (output += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Docker build ${imageName} → ${res.statusCode}: ${output}`));
          return;
        }
        for (const line of output.split('\n').filter(Boolean)) {
          try {
            const obj = JSON.parse(line);
            if (obj.error) { reject(new Error(`Docker build failed: ${obj.error}`)); return; }
          } catch { /* non-JSON line is fine */ }
        }
        resolve();
      });
    });
    req.on('error', reject);
    req.write(tarData);
    req.end();
  });
}

export async function connectNetwork(networkName: string, containerName: string): Promise<void> {
  await dockerRequest('POST', `/networks/${encodeURIComponent(networkName)}/connect`, { Container: containerName });
  // Koppelt de gateway zelf een (internal) devcontainer-net bij, dan zet Podman
  // de aardvark-DNS van dat net vooraan in resolv.conf — die faalt op externe
  // namen. Herstel de volgorde zodat egress blijft werken (zie dns-egress.ts).
  if (containerName === 'huddle') await sanitizeResolvConf();
}

export async function disconnectNetwork(networkName: string, containerName: string): Promise<void> {
  await dockerRequest('POST', `/networks/${encodeURIComponent(networkName)}/disconnect`, { Container: containerName });
  // Ook een disconnect laat Podman resolv.conf opnieuw genereren.
  if (containerName === 'huddle') await sanitizeResolvConf();
}

export async function deleteNetwork(name: string): Promise<void> {
  await dockerRequest('DELETE', `/networks/${encodeURIComponent(name)}`);
}

export async function forceDeleteContainer(containerId: string): Promise<void> {
  await dockerRequest('DELETE', `/containers/${encodeURIComponent(containerId)}?force=true`);
}

export async function startExistingContainer(containerId: string): Promise<void> {
  await dockerRequest('POST', `/containers/${encodeURIComponent(containerId)}/start`, {});
}

export async function cleanupContainerNetwork(containerName: string): Promise<void> {
  const netName = `dc-net-${containerName}`;
  if (!(await networkExists(netName))) return;
  try { await disconnectNetwork(netName, 'huddle'); } catch {}
  try { await deleteNetwork(netName); } catch {}
}

// Seed de gedeelde AI-CLI-volumes met de image-defaults wanneer het volume nog
// leeg is. De named volumes verbergen de COPY's uit de Dockerfile, dus zonder
// deze stap mist een vers volume CLAUDE.md/AGENTS.md/agents enz. `cp -rn`
// overschrijft nooit bestaande bestanden, dus een al ingelogd/geconfigureerd
// volume blijft ongemoeid.
function buildFolderMappingSeedScript(containerPaths: string[]): string {
  if (containerPaths.length === 0) return '';
  const pairs = containerPaths
    .map(p => {
      const rel = p.replace(/^\/home\/vscode\//, '');
      const defaultsRel = `${rel}-defaults`;
      return `"${rel}:${defaultsRel}"`;
    })
    .join(' ');
  return `# Seed volume-gemounte AI CLI-instellingen vanuit de image-defaults bij leeg volume.
for pair in ${pairs}; do
  dest="/home/vscode/\${pair%%:*}"
  src="/home/vscode/\${pair##*:}"
  [ -d "$src" ] || continue
  if [ -z "$(ls -A "$dest" 2>/dev/null)" ]; then
    mkdir -p "$dest"
    cp -rn "$src"/. "$dest"/ 2>/dev/null || true
    chown -R vscode:vscode "$dest" 2>/dev/null || true
  fi
done`;
}

// Docker-toegang loopt via de socket in de gemounte directory /var/run/huddle
// (zie DOCKER_HOST). Symlink het defaultpad voor tools die DOCKER_HOST negeren.
// Gedeeld tussen het JetBrains- en het VS Code-startscript.
const DOCKER_SOCK_SYMLINK = `# Docker-toegang loopt via de socket in de gemounte directory /var/run/huddle
# (zie DOCKER_HOST). Symlink het defaultpad voor tools die DOCKER_HOST negeren.
ln -sfn /var/run/huddle/docker.sock /var/run/docker.sock 2>/dev/null || true`;

// ── jb-config.sh — same logic as devcontainer-manager.ps1 ───────────────────

function buildJbConfigScript(containerWorkspace: string, containerName: string, ideName: IdeName, password: string, caCertPem: string, seedScript: string): string {
  const ideFilter = ideName === 'rider' ? 'rider' : 'idea';
  const caB64 = Buffer.from(caCertPem, 'utf8').toString('base64');
  return `#!/bin/sh
IDEA_DIR=$(ls /.jbdevcontainer/JetBrains/RemoteDev/dist/ 2>/dev/null | grep -i ${ideFilter} | sort -t- -k2 -V | tail -1)
IDEA_PATH="/.jbdevcontainer/JetBrains/RemoteDev/dist/$IDEA_DIR"
BUILD=$(awk -F'"' '/"buildNumber"/ {print $4; exit}' "$IDEA_PATH/product-info.json" 2>/dev/null)
CODE=$(awk -F'"' '/"productCode"/ {print $4; exit}' "$IDEA_PATH/product-info.json" 2>/dev/null)
PROJ="${containerWorkspace}"
mkdir -p /.jbdevcontainer/config/JetBrains
if [ -n "$IDEA_DIR" ]; then
  printf '{"connectionParams":{"type":"docker","projectPath":"%s","deploy":"false","idePath":"%s","buildNumber":"%s","productCode":"%s"},"forwardPorts":{},"customizations":{"jetbrains":{}}}' "$PROJ" "$IDEA_PATH" "$BUILD" "$CODE" > /.jbdevcontainer/config/JetBrains/host-config.json
else
  # IDE nog niet in dist/ (lege gedeelde volume op nieuwe machine).
  # deploy:true laat IntelliJ de backend zelf downloaden en installeren.
  # Na die eerste deploy staat de IDE in de volume en werkt alles daarna normaal.
  echo "[jb-config] IDE niet gevonden in dist/, host-config met deploy:true schrijven zodat IntelliJ de backend installeert"
  printf '{"connectionParams":{"type":"docker","projectPath":"%s","deploy":"true"},"forwardPorts":{},"customizations":{"jetbrains":{}}}' "$PROJ" > /.jbdevcontainer/config/JetBrains/host-config.json
  # Achtergrond-watcher: zodra IntelliJ de IDE heeft geïnstalleerd, importeer de
  # Huddle CA alsnog in het JBR-keystore (de huddle-ca.crt is dan al aangemaakt).
  ( i=0
    while [ $i -lt 60 ]; do
      INST=$(ls /.jbdevcontainer/JetBrains/RemoteDev/dist/ 2>/dev/null | grep -i ${ideFilter} | sort -t- -k2 -V | tail -1)
      if [ -n "$INST" ]; then
        INST_PATH="/.jbdevcontainer/JetBrains/RemoteDev/dist/$INST"
        j=0
        while [ ! -x "$INST_PATH/jbr/bin/keytool" ] && [ $j -lt 30 ]; do sleep 10; j=$((j+1)); done
        if [ -x "$INST_PATH/jbr/bin/keytool" ] && [ -f "$INST_PATH/jbr/lib/security/cacerts" ]; then
          "$INST_PATH/jbr/bin/keytool" -delete -alias huddle-ca -keystore "$INST_PATH/jbr/lib/security/cacerts" -storepass changeit >/dev/null 2>&1 || true
          "$INST_PATH/jbr/bin/keytool" -importcert -noprompt -trustcacerts -alias huddle-ca \\
            -file /usr/local/share/ca-certificates/huddle-ca.crt \\
            -keystore "$INST_PATH/jbr/lib/security/cacerts" -storepass changeit >/dev/null 2>&1 \\
            && echo "[jb-config] huddle CA in JBR-keystore geimporteerd (na deploy)" \\
            || echo "[jb-config] WAARSCHUWING: JBR-keystore import faalde (na deploy)"
        fi
        break
      fi
      sleep 30; i=$((i+1))
    done ) &
fi

CURL_LINE='--proxy-header "X-Container-ID: ${containerName}"'
grep -qF "$CURL_LINE" /home/vscode/.curlrc 2>/dev/null || echo "$CURL_LINE" >> /home/vscode/.curlrc

${DOCKER_SOCK_SYMLINK}

HUDDLE_IP=$(getent hosts huddle | awk '{print $1}')
iptables -t nat -C OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80" 2>/dev/null || \\
  iptables -t nat -A OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80"
iptables -C OUTPUT -o lo -j ACCEPT 2>/dev/null || iptables -A OUTPUT -o lo -j ACCEPT
iptables -C OUTPUT -p tcp -d "$HUDDLE_IP" -j ACCEPT 2>/dev/null || iptables -A OUTPUT -p tcp -d "$HUDDLE_IP" -j ACCEPT
iptables -C OUTPUT -p tcp -j DROP 2>/dev/null || iptables -A OUTPUT -p tcp -j DROP

# Installeer huddle's MITM-CA in de system trust store + zet env-vars voor
# tools die niet uit de system store lezen (node).
mkdir -p /usr/local/share/ca-certificates
echo '${caB64}' | base64 -d > /usr/local/share/ca-certificates/huddle-ca.crt
chmod 644 /usr/local/share/ca-certificates/huddle-ca.crt
command -v update-ca-certificates >/dev/null 2>&1 && update-ca-certificates >/dev/null 2>&1 || true
printf 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/huddle-ca.crt\\n' > /etc/profile.d/99-huddle-ca.sh
chmod 644 /etc/profile.d/99-huddle-ca.sh

# De JetBrains-IDE (IntelliJ/Rider) draait op de JBR, een eigen JVM die TLS niet
# tegen de system store of NODE_EXTRA_CA_CERTS valideert maar tegen z'n eigen
# cacerts-keystore. Zonder import hieronder weigert de IDE het MITM-leaf-cert en
# sterft de handshake, waardoor IDE-HTTPS (bv. api.github.com) alleen als lege
# CONNECT-tunnel in de audit log belandt. Default keystore-wachtwoord: changeit.
# Sla over als IDE nog niet in dist/ staat (eerste connect op nieuwe machine);
# IntelliJ importeert de CA zelf na de eerste deployment.
if [ -n "$IDEA_DIR" ]; then
JBR_KEYTOOL="$IDEA_PATH/jbr/bin/keytool"
JBR_CACERTS="$IDEA_PATH/jbr/lib/security/cacerts"
if [ -x "$JBR_KEYTOOL" ] && [ -f "$JBR_CACERTS" ]; then
  "$JBR_KEYTOOL" -delete -alias huddle-ca -keystore "$JBR_CACERTS" -storepass changeit >/dev/null 2>&1 || true
  "$JBR_KEYTOOL" -importcert -noprompt -trustcacerts -alias huddle-ca \\
    -file /usr/local/share/ca-certificates/huddle-ca.crt \\
    -keystore "$JBR_CACERTS" -storepass changeit >/dev/null 2>&1 \\
    && echo "[jb-config] huddle CA in JBR-keystore geimporteerd" \\
    || echo "[jb-config] WAARSCHUWING: JBR-keystore import faalde"
else
  echo "[jb-config] WAARSCHUWING: JBR keytool/cacerts niet gevonden op $IDEA_PATH/jbr"
fi
fi

# Install sudo + passwd if missing (update index first; base image wipes /var/lib/apt/lists)
export DEBIAN_FRONTEND=noninteractive
command -v sudo >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y --no-install-recommends sudo passwd; }
id noot >/dev/null 2>&1 || useradd -m -s /bin/bash noot
echo "noot:${password}" | chpasswd
usermod -aG sudo noot 2>/dev/null || usermod -aG wheel noot 2>/dev/null || true

# Fix workspace permissions
mkdir -p "${containerWorkspace}" 2>/dev/null || true
chown -R vscode:vscode "${containerWorkspace}" 2>/dev/null || true
chmod -R u+rwX "${containerWorkspace}" 2>/dev/null || true

${seedScript}

# Configure sudo audit logging
mkdir -p /etc/sudoers.d
printf 'Defaults logfile=/tmp/sudo-audit.log\\n' > /etc/sudoers.d/99-huddle-audit
chmod 440 /etc/sudoers.d/99-huddle-audit 2>/dev/null || true

# Start sudo log forwarder (posts new lines to Huddle API via the proxy)
touch /tmp/sudo-audit.log
( tail -F /tmp/sudo-audit.log 2>/dev/null | while IFS= read -r line; do
    [ -z "\$line" ] && continue
    curl -sf -X POST "http://huddle:3000/api/audit/sudo" \\
      -H "Content-Type: application/json" \\
      -d "{\\"container\\":\\"${containerName}\\",\\"entry\\":\\"\$(echo "\$line" | sed 's/\\"/\\\\\\"/g')\\"}" >/dev/null 2>&1 || true
  done ) &

# Start IDE backend in background; sla over als IDE nog niet in dist/ staat
if [ -n "$IDEA_DIR" ]; then
nohup "$IDEA_PATH/bin/remote-dev-server.sh" run "$PROJ" > "$PROJ/rider-client-diagnose.log" 2>&1 &
fi

`;
}

// ── vsc-config.sh — VS Code-variant ─────────────────────────────────────────
// Zelfde firewall/sudo/audit-setup als de JB-flow, maar zónder JB host-config en
// zónder remote-dev-server: VS Code installeert zijn eigen backend (VS Code Server)
// bij het attachen. Houd dit in sync met de vscode-branch in huddle.ps1.
function buildVscodeConfigScript(containerWorkspace: string, containerName: string, password: string, caCertPem: string, seedScript: string): string {
  const caB64 = Buffer.from(caCertPem, 'utf8').toString('base64');
  return `#!/bin/sh
CURL_LINE='--proxy-header "X-Container-ID: ${containerName}"'
grep -qF "$CURL_LINE" /home/vscode/.curlrc 2>/dev/null || echo "$CURL_LINE" >> /home/vscode/.curlrc

${DOCKER_SOCK_SYMLINK}

HUDDLE_IP=$(getent hosts huddle | awk '{print $1}')
iptables -t nat -C OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80" 2>/dev/null || \\
  iptables -t nat -A OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80"
iptables -C OUTPUT -o lo -j ACCEPT 2>/dev/null || iptables -A OUTPUT -o lo -j ACCEPT
iptables -C OUTPUT -p tcp -d "$HUDDLE_IP" -j ACCEPT 2>/dev/null || iptables -A OUTPUT -p tcp -d "$HUDDLE_IP" -j ACCEPT
iptables -C OUTPUT -p tcp -j DROP 2>/dev/null || iptables -A OUTPUT -p tcp -j DROP

# Installeer huddle's MITM-CA in de system trust store + zet env-vars voor
# tools die niet uit de system store lezen (node, java).
mkdir -p /usr/local/share/ca-certificates
echo '${caB64}' | base64 -d > /usr/local/share/ca-certificates/huddle-ca.crt
chmod 644 /usr/local/share/ca-certificates/huddle-ca.crt
command -v update-ca-certificates >/dev/null 2>&1 && update-ca-certificates >/dev/null 2>&1 || true
printf 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/huddle-ca.crt\\n' > /etc/profile.d/99-huddle-ca.sh
chmod 644 /etc/profile.d/99-huddle-ca.sh

# Install sudo + passwd if missing (update index first; base image wipes /var/lib/apt/lists)
export DEBIAN_FRONTEND=noninteractive
command -v sudo >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y --no-install-recommends sudo passwd; }
id noot >/dev/null 2>&1 || useradd -m -s /bin/bash noot
echo "noot:${password}" | chpasswd
usermod -aG sudo noot 2>/dev/null || usermod -aG wheel noot 2>/dev/null || true

# Fix workspace permissions
mkdir -p "${containerWorkspace}" 2>/dev/null || true
chown -R vscode:vscode "${containerWorkspace}" 2>/dev/null || true
chmod -R u+rwX "${containerWorkspace}" 2>/dev/null || true

${seedScript}

# Configure sudo audit logging
mkdir -p /etc/sudoers.d
printf 'Defaults logfile=/tmp/sudo-audit.log\\n' > /etc/sudoers.d/99-huddle-audit
chmod 440 /etc/sudoers.d/99-huddle-audit 2>/dev/null || true

# Start sudo log forwarder (posts new lines to Huddle API via the proxy)
touch /tmp/sudo-audit.log
( tail -F /tmp/sudo-audit.log 2>/dev/null | while IFS= read -r line; do
    [ -z "\$line" ] && continue
    curl -sf -X POST "http://huddle:3000/api/audit/sudo" \\
      -H "Content-Type: application/json" \\
      -d "{\\"container\\":\\"${containerName}\\",\\"entry\\":\\"\$(echo "\$line" | sed 's/\\"/\\\\\\"/g')\\"}" >/dev/null 2>&1 || true
  done ) &

`;
}

function toLinuxPath(p: string): string {
  if (p.startsWith('/')) return p;
  const normalized = p.replace(/\\/g, '/');
  const match = normalized.match(/^([a-zA-Z]):\/(.*)/);
  if (match) return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  return p;
}

interface FolderMount { Type: 'bind' | 'volume'; Source: string; Target: string; ReadOnly?: boolean; }

function buildFolderMounts(containerName: string): FolderMount[] {
  const mappings = listFolderMappings();
  const result: FolderMount[] = [];
  for (const m of mappings) {
    if (!m.enabled) continue;
    const target = m.container_path;
    const readOnly = m.read_only === 1;
    if (m.host_path && m.host_path.trim()) {
      result.push({ Type: 'bind', Source: m.host_path.trim(), Target: target, ReadOnly: readOnly });
    } else if (m.volume_name && m.volume_name.trim()) {
      const volName = m.volume_name.trim().replace('{containerName}', containerName);
      result.push({ Type: 'volume', Source: volName, Target: target, ReadOnly: readOnly });
    }
  }
  return result;
}

export interface StartParams {
  imageName: string;
  workspaceDir: string;     // host path, forward slashes; empty string when empty=true
  containerName: string;
  containerWorkspace: string; // /workspaces/<leaf>
  presentableName: string;
  ideName?: IdeName;
  empty?: boolean;
  memory?: string;
  cpus?: string;
}

function parseMemoryBytes(s: string): number {
  if (!s) return 0;
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([gmkGMK]?)b?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'g') return Math.floor(n * 1024 * 1024 * 1024);
  if (unit === 'm') return Math.floor(n * 1024 * 1024);
  if (unit === 'k') return Math.floor(n * 1024);
  return Math.floor(n);
}

function parseCpuQuota(s: string): number {
  if (!s) return 0;
  const n = parseFloat(s.trim());
  if (isNaN(n) || n <= 0) return 0;
  return Math.floor(n * 100000);
}

export async function createAndStartContainer(params: StartParams): Promise<string> {
  const { imageName, workspaceDir, containerName, containerWorkspace, presentableName } = params;
  const ideName = params.ideName ?? 'intellij';
  const empty = params.empty === true;
  // VS Code installeert zijn eigen backend (VS Code Server) bij het attachen: geen
  // JB host-config, geen RemoteDev-distro-volume, geen remote-dev-server launch.
  const isVscode = ideName === 'vscode';
  const devcontainerId = crypto.randomUUID().replace(/-/g, '');
  const backend = ideName === 'rider' ? 'Rider' : isVscode ? 'VSCode' : 'IntelliJ';
  const modelJson = `{"customizations":{"jetbrains":{"backend":"${backend}"}}}`;
  const metadataJson = '[{"remoteUser":"vscode"}]';

  const password = crypto.randomBytes(12).toString('base64url');

  try {
    const existing = await inspectContainer(containerName);
    const existingIde = existing?.Config?.Labels?.['com.devcontainer.ide'] ?? ideFromContainerLabels(existing?.Config?.Labels);
    throw new Error(
      `Container '${containerName}' bestaat al${existingIde ? ` (${existingIde})` : ''}. ` +
      `Verwijder die container eerst of kies een andere naam met --name.`
    );
  } catch (err: any) {
    if (!String(err.message).includes(`Docker API GET /containers/${encodeURIComponent(containerName)}/json → 404:`)) {
      throw err;
    }
  }

  const netName = `dc-net-${containerName}`;
  if (!(await networkExists(netName))) {
    await createNetwork(netName);
  }
  try {
    await connectNetwork(netName, 'huddle');
  } catch (err: any) {
    // Al gekoppeld is geen fout. Docker en Podman formuleren dit verschillend:
    // Docker → "already exists in network", Podman → "network is already connected".
    const msg = String(err.message);
    if (!msg.includes('already exists in network') && !msg.includes('already connected')) throw err;
  }

  if (!(await imageExists(imageName))) {
    const dockerfilePath = `/base-devimage-${ideName}/Dockerfile`;
    if (!fs.existsSync(dockerfilePath)) {
      throw new Error(`Image '${imageName}' not found and ${dockerfilePath} is not mounted`);
    }
    console.log(`[huddle] Building base image '${imageName}' from ${dockerfilePath}...`);
    await buildImage(imageName, dockerfilePath);
    console.log(`[huddle] Base image '${imageName}' built successfully`);
  }

  // Create per-container Docker socket proxy (injects X-Container-Id for OPA policy)
  await createContainerProxy(containerName, SOCKET_DIR);

  // JB-specifieke env (host-config pad, JBR/RemoteDev data, java-proxy) slaan we
  // over voor VS Code; de proxy- en user-env blijven gelijk.
  const env = [
    '_CONTAINER_USER=vscode',
    '_CONTAINER_USER_HOME=/home/vscode',
    '_REMOTE_USER=vscode',
    '_REMOTE_USER_HOME=/home/vscode',
    'http_proxy=http://huddle:80',
    'https_proxy=http://huddle:80',
    'HTTP_PROXY=http://huddle:80',
    'HTTPS_PROXY=http://huddle:80',
    // Loopback mag nooit via de proxy: die kan de loopback van de container
    // zelf niet bereiken. De bracketed vorm `[::1]` staat er expliciet bij
    // omdat .NET/Aspire's DCP zijn targets als `http://[::1]:<port>` adresseert
    // en NO_PROXY letterlijk tegen die bracketed host matcht (issue #12).
    'no_proxy=localhost,127.0.0.1,::1,[::1]',
    'NO_PROXY=localhost,127.0.0.1,::1,[::1]',
    // CA-trust op container-niveau zodat ELK proces de MITM-CA vertrouwt — niet
    // alleen login-shells die /etc/profile.d sourcen. Zonder dit valideren tools
    // die door de IDE/non-login-shell gestart worden tegen hun eigen bundle,
    // weigeren ze het leaf-cert en zie je enkel een lege CONNECT-tunnel.
    // NODE_EXTRA_CA_CERTS = los huddle-cert (Node voegt het toe aan z'n bundle).
    // SSL_CERT_FILE/REQUESTS_CA_BUNDLE = de gecombineerde system-bundle (huddle
    // + alle normale roots) die update-ca-certificates regenereert, zodat TLS
    // naar niet-geïntercepte hosts blijft werken.
    'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/huddle-ca.crt',
    'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt',
    'REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt',
    // De docker-proxy-socket zit in de gemounte directory /var/run/huddle (zie
    // Mounts). DOCKER_HOST laat docker/compose/SDK's hem daar vinden; voor tools
    // die het defaultpad hardcoden legt het config-script ook een symlink op
    // /var/run/docker.sock.
    'DOCKER_HOST=unix:///var/run/huddle/docker.sock',
    ...(isVscode ? [] : [
      'DEVCONTAINER_CONFIG_PATH=/.jbdevcontainer/config/JetBrains/host-config.json',
      'XDG_DATA_HOME=/.jbdevcontainer/data',
      'JAVA_TOOL_OPTIONS=-Dhttp.proxyHost=huddle -Dhttp.proxyPort=80 -Dhttps.proxyHost=huddle -Dhttps.proxyPort=80 -Dhttp.nonProxyHosts=localhost|127.*|[::1]',
    ]),
  ];

  const effectiveSource = empty ? '' : await ensureWorktree(toLinuxPath(workspaceDir), containerName);

  const folderMounts = buildFolderMounts(containerName);

  // De RemoteDev-distro-volume is JB-only; VS Code heeft hem niet nodig.
  const mounts = [
    ...folderMounts,
    ...(isVscode ? [] : [{
      Type: 'volume',
      Source: 'jb_devcontainers_shared_volume',
      Target: '/.jbdevcontainer/JetBrains/RemoteDev/dist',
    }]),
    ...(empty ? [] : [{
      Type: 'bind',
      Source: effectiveSource,
      Target: containerWorkspace,
    }]),
    {
      // Mount de per-container socket-DIRECTORY, niet het socket-bestand zelf:
      // een file-bind pint de inode en wijst na een huddle-herstart (unlink +
      // nieuwe socket) voorgoed naar de dode oude socket. Via de directory ziet
      // de container altijd de actuele socket; DOCKER_HOST (env) en de symlink
      // /var/run/docker.sock (config-script) wijzen ernaar.
      Type: 'bind',
      Source: `${SOCKET_DIR}/${containerName}`,
      Target: '/var/run/huddle',
    },
  ];

  const createBody = {
    Image: imageName,
    Entrypoint: ['/bin/sh'],
    Cmd: ['-c', 'while sleep 1000; do :; done'],
    Env: env,
    Labels: {
      'com.intellij.devcontainer.id': devcontainerId,
      'com.intellij.devcontainer.presentable.name': presentableName,
      'com.intellij.devcontainer.sources.path': empty ? '' : workspaceDir,
      'com.intellij.devcontainer.workspace.path': containerWorkspace,
      'com.intellij.devcontainer.model': modelJson,
      'com.devcontainer.ide': ideName,
      'devcontainer.metadata': metadataJson,
    },
    HostConfig: {
      Mounts: mounts,
      NetworkMode: netName,
      CapAdd: ['NET_ADMIN'],
      ...(RUNTIME_SECURITY_OPT.length ? { SecurityOpt: RUNTIME_SECURITY_OPT } : {}),
      Memory: parseMemoryBytes(params.memory || getSetting('defaultMemory') || '8g'),
      CpuQuota: parseCpuQuota(params.cpus || getSetting('defaultCpus') || '2'),
      CpuPeriod: 100000,
    },
  };

  const created = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, createBody);
  const id: string = created.Id;
  await dockerRequest('POST', `/containers/${id}/start`, {});

  const containerPaths = folderMounts.map(m => m.Target);
  const seedScript = buildFolderMappingSeedScript(containerPaths);

  // Run config script via exec — VS Code-variant zonder JB host-config/backend.
  const script = isVscode
    ? buildVscodeConfigScript(containerWorkspace, containerName, password, getCaCertPem(), seedScript)
    : buildJbConfigScript(containerWorkspace, containerName, ideName, password, getCaCertPem(), seedScript);
  const execCreate = await dockerRequest('POST', `/containers/${id}/exec`, {
    User: 'root',
    Cmd: ['sh', '-c', script],
  });
  await dockerRequest('POST', `/exec/${execCreate.Id}/start`, { Detach: true });

  saveCredentials(containerName, password);

  return id;
}
