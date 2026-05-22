import http from 'http';
import crypto from 'crypto';
import { createContainerProxy } from './socket-proxy';

const SOCKET_DIR = '/tmp/dc-sockets';

// ── IP → container name cache (used by proxy) ────────────────────────────────

const CACHE_TTL_MS = 10_000;
let ipToName = new Map<string, string>();
let cacheExpiry = 0;

// ── Generic Docker socket helpers ────────────────────────────────────────────

function dockerRequest(method: string, path: string, body?: unknown): Promise<any> {
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
    for (const net of Object.values<any>(c.NetworkSettings?.Networks ?? {})) {
      if (net.IPAddress) map.set(net.IPAddress, name);
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
}

export async function listDevcontainers(): Promise<DevcontainerInfo[]> {
  const filters = JSON.stringify({ label: ['com.intellij.devcontainer.id'] });
  const containers: any[] = await dockerRequest('GET', `/containers/json?filters=${encodeURIComponent(filters)}`);
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
    };
  });
}

export function getBaseImageName(): string {
  return process.env.BASE_IMAGE ?? 'base-devimage';
}

export async function inspectContainer(name: string): Promise<any> {
  return dockerRequest('GET', `/containers/${encodeURIComponent(name)}/json`);
}

export interface SnapshotImage {
  id: string;
  name: string;
  size: number;
  created: number;
}

export async function listSnapshotImages(): Promise<SnapshotImage[]> {
  const filters = JSON.stringify({ label: ['com.devcontainer.snapshot=true'] });
  const images: any[] = await dockerRequest('GET', `/images/json?filters=${encodeURIComponent(filters)}`);
  return images.map((img) => ({
    id: img.Id,
    name: (img.RepoTags?.[0] as string) ?? img.Id.substring(7, 19),
    size: img.Size,
    created: img.Created,
  }));
}

export async function commitContainer(containerId: string, imageName: string): Promise<string> {
  const [repo, tag = 'latest'] = imageName.split(':');
  const result = await dockerRequest(
    'POST',
    `/commit?container=${encodeURIComponent(containerId)}&repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
    {
      Labels: {
        'com.devcontainer.snapshot': 'true',
        'com.devcontainer.source': containerId,
        'com.devcontainer.created': new Date().toISOString(),
      },
    }
  );
  return result.Id ?? '';
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
  await dockerRequest('POST', '/networks/create', { Name: name });
}

export async function connectNetwork(networkName: string, containerName: string): Promise<void> {
  await dockerRequest('POST', `/networks/${encodeURIComponent(networkName)}/connect`, { Container: containerName });
}

export async function disconnectNetwork(networkName: string, containerName: string): Promise<void> {
  await dockerRequest('POST', `/networks/${encodeURIComponent(networkName)}/disconnect`, { Container: containerName });
}

export async function deleteNetwork(name: string): Promise<void> {
  await dockerRequest('DELETE', `/networks/${encodeURIComponent(name)}`);
}

export async function forceDeleteContainer(containerId: string): Promise<void> {
  await dockerRequest('DELETE', `/containers/${encodeURIComponent(containerId)}?force=true`);
}

export async function cleanupContainerNetwork(containerName: string): Promise<void> {
  const netName = `dc-net-${containerName}`;
  if (!(await networkExists(netName))) return;
  try { await disconnectNetwork(netName, 'huddle'); } catch {}
  try { await deleteNetwork(netName); } catch {}
}

// ── jb-config.sh — same logic as devcontainer-manager.ps1 ───────────────────

function buildJbConfigScript(containerWorkspace: string, containerName: string, ideName: 'intellij' | 'rider'): string {
  const ideFilter = ideName === 'rider' ? 'rider' : 'idea';
  return `#!/bin/sh
IDEA_DIR=$(ls /.jbdevcontainer/JetBrains/RemoteDev/dist/ | grep -i ${ideFilter} | sort -t- -k2 -V | tail -1)
IDEA_PATH="/.jbdevcontainer/JetBrains/RemoteDev/dist/$IDEA_DIR"
BUILD=$(grep -o '"buildNumber":"[^"]*"' "$IDEA_PATH/product-info.json" | cut -d'"' -f4)
CODE=$(grep -o '"productCode":"[^"]*"' "$IDEA_PATH/product-info.json" | cut -d'"' -f4)
PROJ="${containerWorkspace}"
mkdir -p /.jbdevcontainer/config/JetBrains
printf '{"connectionParams":{"type":"docker","projectPath":"%s","deploy":"false","idePath":"%s","buildNumber":"%s","productCode":"%s"},"forwardPorts":{},"customizations":{"jetbrains":{}}}' "$PROJ" "$IDEA_PATH" "$BUILD" "$CODE" > /.jbdevcontainer/config/JetBrains/host-config.json

CURL_LINE='--proxy-header "X-Container-ID: ${containerName}"'
grep -qF "$CURL_LINE" /home/vscode/.curlrc 2>/dev/null || echo "$CURL_LINE" >> /home/vscode/.curlrc

HUDDLE_IP=$(getent hosts huddle | awk '{print $1}')
iptables -t nat -C OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80" 2>/dev/null || \\
  iptables -t nat -A OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80"
`;
}

function toLinuxPath(p: string): string {
  if (p.startsWith('/')) return p;
  const normalized = p.replace(/\\/g, '/');
  const match = normalized.match(/^([a-zA-Z]):\/(.*)/);
  if (match) return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  return p;
}

export interface StartParams {
  imageName: string;
  workspaceDir: string;     // host path, forward slashes
  containerName: string;
  containerWorkspace: string; // /workspaces/<leaf>
  presentableName: string;
  ideName?: 'intellij' | 'rider';
}

export async function createAndStartContainer(params: StartParams): Promise<string> {
  const { imageName, workspaceDir, containerName, containerWorkspace, presentableName } = params;
  const ideName = params.ideName ?? 'intellij';
  const devcontainerId = crypto.randomUUID().replace(/-/g, '');
  const modelJson = '{"customizations":{"jetbrains":{"backend":"IntelliJ"}}}';
  const metadataJson = '[{"remoteUser":"vscode"}]';

  const netName = `dc-net-${containerName}`;
  await createNetwork(netName);
  await connectNetwork(netName, 'huddle');

  // Create per-container Docker socket proxy (injects X-Container-Id for OPA policy)
  await createContainerProxy(containerName, SOCKET_DIR);

  const createBody = {
    Image: imageName,
    Entrypoint: ['/bin/sh'],
    Cmd: ['-c', 'while sleep 1000; do :; done'],
    Env: [
      'DEVCONTAINER_CONFIG_PATH=/.jbdevcontainer/config/JetBrains/host-config.json',
      '_CONTAINER_USER=vscode',
      '_CONTAINER_USER_HOME=/home/vscode',
      '_REMOTE_USER=vscode',
      '_REMOTE_USER_HOME=/home/vscode',
      'XDG_DATA_HOME=/.jbdevcontainer/data',
      'http_proxy=http://huddle:80',
      'https_proxy=http://huddle:80',
      'HTTP_PROXY=http://huddle:80',
      'HTTPS_PROXY=http://huddle:80',
      'JAVA_TOOL_OPTIONS=-Dhttp.proxyHost=huddle -Dhttp.proxyPort=80 -Dhttps.proxyHost=huddle -Dhttps.proxyPort=80 -Dhttp.nonProxyHosts=',
    ],
    Labels: {
      'com.intellij.devcontainer.id': devcontainerId,
      'com.intellij.devcontainer.presentable.name': presentableName,
      'com.intellij.devcontainer.sources.path': workspaceDir,
      'com.intellij.devcontainer.workspace.path': containerWorkspace,
      'com.intellij.devcontainer.model': modelJson,
      'devcontainer.metadata': metadataJson,
    },
    HostConfig: {
      Mounts: [
        {
          Type: 'volume',
          Source: 'jb_devcontainers_shared_volume',
          Target: '/.jbdevcontainer/JetBrains/RemoteDev/dist',
        },
        {
          Type: 'bind',
          Source: toLinuxPath(workspaceDir),
          Target: containerWorkspace,
        },
        {
          Type: 'bind',
          Source: `${SOCKET_DIR}/${containerName}.sock`,
          Target: '/var/run/docker.sock',
        },
      ],
      NetworkMode: netName,
      CapAdd: ['NET_ADMIN'],
    },
  };

  const created = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, createBody);
  const id: string = created.Id;
  await dockerRequest('POST', `/containers/${id}/start`, {});

  // Run jb-config.sh via exec
  const script = buildJbConfigScript(containerWorkspace, containerName, ideName);
  const execCreate = await dockerRequest('POST', `/containers/${id}/exec`, {
    User: 'root',
    Cmd: ['sh', '-c', script],
  });
  await dockerRequest('POST', `/exec/${execCreate.Id}/start`, { Detach: true });

  return id;
}
