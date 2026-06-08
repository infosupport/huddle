export interface McpSetting {
  key: string;
  label: string;
  secret?: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  version: string;
  image: string;
  port: number;
  transport: 'sse' | 'http';
  settings: McpSetting[];
  containerId: string | null;
  status: 'stopped' | 'starting' | 'running' | 'error';
  createdAt: number;
}
