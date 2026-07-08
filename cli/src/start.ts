import fs from 'fs';
import path from 'path';
import { get, post } from './api';
import { bold, green, cyan, dim } from './utils';

export interface StartOptions {
  ide: string;
  workspace?: string;
  name?: string;
  image?: string;
  empty: boolean;
}

type IdeName = 'rider' | 'intellij' | 'vscode';

interface BaseImageResponse {
  imageName: string;
}

interface StartResponse {
  id: string;
  containerName: string;
}

export async function runStart(opts: StartOptions): Promise<void> {
  const ide = parseIde(opts.ide);
  const workspaceDir = opts.empty ? undefined : resolveWorkspace(opts.workspace);
  const baseName = opts.empty ? 'empty' : path.basename(workspaceDir!);
  const containerName = opts.name ? validateContainerName(opts.name) : defaultContainerName(baseName);

  console.log(`Starting ${bold(containerName)} with ${bold(ide)}...`);
  if (workspaceDir) console.log(dim(`Workspace: ${workspaceDir}`));

  let imageName = opts.image;
  if (!imageName) {
    const res = await get<BaseImageResponse>(`/api/docker/base-image?ide=${encodeURIComponent(ide)}`);
    imageName = res.imageName;
    console.log(dim(`Image: ${imageName}`));
  }

  const body: {
    imageName: string;
    containerName: string;
    ideName: IdeName;
    empty?: boolean;
    workspaceDir?: string;
  } = {
    imageName,
    containerName,
    ideName: ide,
  };

  if (opts.empty) {
    body.empty = true;
  } else {
    body.workspaceDir = workspaceDir;
  }

  const result = await post<StartResponse>('/api/docker/start', body);

  console.log(green(`[OK] Container started: ${result.containerName} (${result.id.slice(0, 12)})`));
  console.log();

  if (ide === 'vscode') {
    console.log(`Open in VS Code: ${cyan('Dev Containers: Attach to Running Container')} -> ${bold(result.containerName)}`);
    return;
  }

  console.log(`Open in JetBrains Gateway: ${cyan('Remote Development > Dev Containers')} -> ${bold(result.containerName)}`);
  await tryPrintIdeLink(result.containerName);
}

async function tryPrintIdeLink(containerName: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  try {
    const res = await get<{ link?: string }>(`/api/docker/containers/${encodeURIComponent(containerName)}/ide-link`);
    if (res?.link) console.log(dim(`Gateway-link: ${res.link}`));
  } catch {
    // The IDE link is best-effort; JetBrains may still be starting the backend.
  }
}

function resolveWorkspace(workspace?: string): string {
  const resolved = path.resolve(workspace ?? process.cwd());
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Workspace directory does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }
  return resolved.replace(/[\\/]+$/, '');
}

function defaultContainerName(baseName: string): string {
  const slug = baseName.toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[_.-]+|[_.-]+$/g, '');
  return `devcontainer-${slug || 'workspace'}`;
}

function validateContainerName(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(trimmed)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  return trimmed;
}

function parseIde(value: string): IdeName {
  const normalized = value.toLowerCase().replace(/[ _-]+/g, '');
  if (normalized === 'rider') return 'rider';
  if (normalized === 'vscode' || normalized === 'code') return 'vscode';
  if (normalized === 'intellij' || normalized === 'intelij' || normalized === 'idea') return 'intellij';
  throw new Error(`Unknown IDE: ${value}. Choose intellij, rider, or vscode.`);
}
