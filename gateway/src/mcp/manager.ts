import { dockerRequest, imageExists } from '../docker';
import { getMcpServer, listMcpServers, updateMcpServerStatus, getMcpValue } from '../db';

export const MCP_NET = 'mcp-net';

// Zorg dat mcp-net bestaat en huddle erin zit
export async function ensureMcpNetwork(): Promise<void> {
  let networks: any[];
  try {
    networks = await dockerRequest('GET', '/networks') as any[];
  } catch { return; }
  const exists = networks.some((n: any) => n.Name === MCP_NET);
  if (!exists) {
    await dockerRequest('POST', '/networks/create', { Name: MCP_NET, Driver: 'bridge' });
  }
  // Verbind huddle ermee als nog niet verbonden
  try {
    await dockerRequest('POST', `/networks/${MCP_NET}/connect`, { Container: 'huddle' });
  } catch (err: any) {
    if (!String(err.message).includes('already exists')) {
      console.warn('[mcp] huddle connect to mcp-net:', err.message);
    }
  }
}

// Haal container IP op in mcp-net
async function getContainerIp(containerId: string): Promise<string> {
  const info = await dockerRequest('GET', `/containers/${containerId}/json`) as any;
  const ip = info?.NetworkSettings?.Networks?.[MCP_NET]?.IPAddress;
  if (!ip) throw new Error(`Geen IP gevonden voor container ${containerId} in ${MCP_NET}`);
  return ip;
}

// Start een MCP-container
export async function startMcpContainer(id: string): Promise<void> {
  const row = getMcpServer(id);
  if (!row) throw new Error(`MCP server "${id}" niet gevonden`);
  if (row.status === 'running' && row.container_id) {
    // Controleer of hij echt draait
    try {
      const info = await dockerRequest('GET', `/containers/${row.container_id}/json`) as any;
      if (info?.State?.Running) return; // Al actief
    } catch {}
  }

  updateMcpServerStatus(id, 'starting', null);

  try {
    // Pull image als niet aanwezig
    if (!(await imageExists(row.image))) {
      console.log(`[mcp] pulling image ${row.image}...`);
      await dockerRequest('POST', `/images/create?fromImage=${encodeURIComponent(row.image)}`, undefined);
      console.log(`[mcp] pulled ${row.image}`);
    }

    await ensureMcpNetwork();

    // Bouw env vars uit opgeslagen settings
    const manifest = JSON.parse(row.manifest_json);
    const settings: Array<{ key: string }> = manifest.settings ?? [];
    const env = [
      `HUDDLE_MCP_BASE=/mcp/${id}`,
      ...settings.map(s => `${s.key.toUpperCase()}=${getMcpValue(id, s.key) ?? ''}`),
    ];

    const containerName = `mcp-${id}`;
    // Verwijder eventuele oude container
    try {
      await dockerRequest('DELETE', `/containers/${containerName}?force=true`, undefined);
    } catch {}

    const created = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, {
      Image: row.image,
      Env: env,
      Labels: { 'huddle.mcp': 'true', 'huddle.mcp.id': id },
      HostConfig: { NetworkMode: MCP_NET },
    }) as any;

    const containerId: string = created.Id;
    await dockerRequest('POST', `/containers/${containerId}/start`, {});

    updateMcpServerStatus(id, 'running', containerId);
    console.log(`[mcp] started "${id}" (${containerId.slice(0, 12)})`);
  } catch (err: any) {
    updateMcpServerStatus(id, 'error', null);
    throw err;
  }
}

// Stop een MCP-container
export async function stopMcpContainer(id: string): Promise<void> {
  const row = getMcpServer(id);
  if (!row?.container_id) { updateMcpServerStatus(id, 'stopped', null); return; }
  try {
    await dockerRequest('POST', `/containers/${row.container_id}/stop`, undefined);
    await dockerRequest('DELETE', `/containers/${row.container_id}?force=true`, undefined);
  } catch (err: any) {
    console.warn(`[mcp] stop "${id}":`, err.message);
  }
  updateMcpServerStatus(id, 'stopped', null);
}

// Geef URL terug waarnaar Huddle verkeer proxied (intern IP)
export async function getMcpTargetUrl(id: string): Promise<string> {
  const row = getMcpServer(id);
  if (!row?.container_id || row.status !== 'running') throw new Error(`MCP server "${id}" draait niet`);
  const ip = await getContainerIp(row.container_id);
  return `http://${ip}:${row.port}`;
}

// Geef config terug voor injectie in devcontainer (alle draaiende servers)
export function getRunningMcpConfigs(): Array<{ id: string; name: string; transport: string; port: number }> {
  const rows = listMcpServers();
  return rows
    .filter(r => r.status === 'running')
    .map(r => ({ id: r.id, name: r.name, transport: r.transport, port: r.port }));
}
