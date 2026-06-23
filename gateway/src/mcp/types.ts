export interface McpSetting {
  key: string;
  label: string;
  secret?: boolean;
  description?: string;
}

export type McpTransport = 'sse' | 'http';

export interface McpManifest {
  id: string;
  name: string;
  version: string;
  image: string;
  port: number;
  transport: McpTransport;
  settings?: McpSetting[];
}

export interface McpServer {
  id: string;
  name: string;
  version: string;
  image: string;
  port: number;
  transport: McpTransport;
  settings: McpSetting[];
  containerId: string | null;
  status: 'stopped' | 'starting' | 'running' | 'error';
  createdAt: number;
}

export function parseManifest(raw: unknown): McpManifest {
  if (typeof raw !== 'object' || raw === null) throw new Error('Manifest moet een object zijn');
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || !/^[a-z0-9-]+$/.test(m.id)) throw new Error('id moet lowercase alfanumeriek zijn');
  if (typeof m.name !== 'string' || !m.name) throw new Error('name is verplicht');
  if (typeof m.version !== 'string' || !m.version) throw new Error('version is verplicht');
  if (typeof m.image !== 'string' || !m.image) throw new Error('image is verplicht');
  const port = Number(m.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port moet een geldig poortnummer zijn');
  const transport = m.transport ?? 'sse';
  if (transport !== 'sse' && transport !== 'http') throw new Error('transport moet "sse" of "http" zijn');
  const settings = Array.isArray(m.settings) ? m.settings as McpSetting[] : [];
  return { id: m.id, name: m.name, version: m.version, image: m.image, port, transport: transport as McpTransport, settings };
}
