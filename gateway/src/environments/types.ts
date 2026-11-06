// Environment providers (docs/host-pipe.md): a host-side tool that makes
// sandboxes, driven through the host pipe. sbx is the first one; adding another
// is one file in this folder plus its binary in the host agent's TOOLS. Nothing
// in the API, the pipe or the portal is provider-specific.

export interface ProviderStatus {
  id: string;
  label: string;
  // Switched on in Huddle. Off: Huddle leaves the tool alone (no list, no create).
  enabled: boolean;
  available: boolean;
  version?: string;
  error?: string;
  // Why it cannot be switched on here (for example: the CLI did not publish the egress port).
  unavailableReason?: string;
  agents: string[];
  recreate?: RecreateState;
}

export interface RecreateResult {
  name: string;
  ok: boolean;
  message?: string;
}

// The last (or running) "recreate every sandbox" run.
export interface RecreateState {
  running: boolean;
  reason: string;
  startedAt: string;
  finishedAt?: string;
  results: RecreateResult[];
}

export interface SandboxInfo {
  name: string;
  provider: string;
  status?: string;
  agent?: string;
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
  isEnabled(): boolean;
  // Switching on routes the sandboxes through Huddle and recreates them all;
  // switching off hands them back. Returns what it ran, for the portal.
  setEnabled(enabled: boolean): Promise<SandboxStep[]>;
  // Recreates every sandbox (in the background); resolves once it has started.
  recreateAll(reason: string): Promise<RecreateState>;
  // A link that opens the sandbox in an IDE over SSH. Optional: not every
  // provider can be reached over SSH.
  ideLink?(name: string, ide: IdeKind): Promise<IdeLink>;
}

export type IdeKind = 'vscode' | 'jetbrains';
export interface IdeLink {
  link: string;
  /** The ssh host alias the link uses, so `ssh <host>` works too. */
  sshHost: string;
}

// The provider is switched off in Huddle → HTTP 409.
export class ProviderDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderDisabledError';
  }
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
