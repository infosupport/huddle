// Environment providers (docs/host-pipe.md): a host-side tool that makes
// sandboxes, driven through the host pipe. sbx is the first one; adding another
// is one file in this folder plus its binary in the host agent's TOOLS. Nothing
// in the API, the pipe or the portal is provider-specific.

export interface ProviderStatus {
  id: string;
  label: string;
  available: boolean;
  version?: string;
  error?: string;
  agents: string[];
}

export interface SandboxInfo {
  name: string;
  provider: string;
  status?: string;
  workspaces?: string[];
}

export interface SandboxWorkspace {
  path: string;      // host path in Huddle notation (host-path.ts)
  readOnly: boolean;
}

export interface SandboxSpec {
  // Optional: the provider generates a default (the naming rules are its own).
  name?: string;
  agent: string;
  workspaces: SandboxWorkspace[];
}

export interface SandboxStep {
  label: string;
  command: string;
  code: number;
  stdout: string;
  stderr: string;
}

export interface SandboxCreateResult {
  name: string;
  ok: boolean;
  steps: SandboxStep[];
}

export interface EnvironmentProvider {
  id: string;
  label: string;
  status(): Promise<ProviderStatus>;
  list(): Promise<SandboxInfo[]>;
  create(spec: SandboxSpec): Promise<SandboxCreateResult>;
  remove(name: string, opts: { force: boolean }): Promise<void>;
}

// A provider refusing input (bad name, relative path, unknown agent) before
// anything ran → HTTP 400.
export class InvalidSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSpecError';
  }
}

// The host tool ran but failed (non-zero exit) → HTTP 502 with its output.
export class ToolFailedError extends Error {
  constructor(message: string, public readonly code: number) {
    super(message);
    this.name = 'ToolFailedError';
  }
}
