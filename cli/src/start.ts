import fs from 'fs';
import path from 'path';
import { get, post } from './api';
import { bold, green, cyan, dim, yellow } from './utils';
import { findImageConfigs, writeAttachedContainerConfig } from './vscode';

export interface StartOptions {
  ide: string;
  workspace?: string;
  name?: string;
  image?: string;
  empty: boolean;
  vscodeConfig?: boolean;
}

type IdeName = 'rider' | 'intellij' | 'vscode';

interface BaseImageResponse {
  imageName: string;
}

interface StartResponse {
  id: string;
  containerName: string;
  /** Mount point inside the container; absent on gateways older than this CLI. */
  containerWorkspace?: string;
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
    const containerWorkspace = result.containerWorkspace ?? containerWorkspacePath(workspaceDir, containerName);
    if (opts.vscodeConfig !== false) {
      configureVscodeAttach(containerName, containerWorkspace, imageName);
    }
    console.log(`Open in VS Code: ${cyan('Dev Containers: Attach to Running Container')} -> ${bold(result.containerName)}`);
    return;
  }

  console.log(`Open in JetBrains Gateway: ${cyan('Remote Development > Dev Containers')} -> ${bold(result.containerName)}`);
  await tryPrintIdeLink(result.containerName);
}

/**
 * Teach VS Code which folder to open on attach. Best-effort: a failure here
 * costs one manual File > Open Folder, never the container itself.
 */
function configureVscodeAttach(containerName: string, containerWorkspace: string, imageName: string): void {
  let result;
  try {
    result = writeAttachedContainerConfig(containerName, containerWorkspace);
  } catch (err) {
    console.log(yellow(`! Could not configure VS Code: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  for (const file of result.written) {
    console.log(dim(`VS Code will open ${containerWorkspace} on attach (${file})`));
  }
  for (const { file, reason } of result.skipped) {
    console.log(yellow(`! Left ${file} untouched: ${reason}`));
  }
  if (!result.written.length && !result.skipped.length) {
    console.log(dim('No VS Code config changes were made; if attach opens an empty window, use File > Open Folder on the container workspace.'));
  }

  // The name-level config above wins for THIS container, but a leftover
  // image-level one still misdirects every other container on the same image.
  for (const file of findImageConfigs(imageName)) {
    console.log(yellow(`! Image-level config still present: ${file} (applies to every container from this image; consider deleting it)`));
  }
}

/** Mirrors the gateway's containerWorkspacePath() for gateways that predate it. */
function containerWorkspacePath(workspaceDir: string | undefined, containerName: string): string {
  const leaf = workspaceDir
    ? workspaceDir.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || containerName
    : containerName.replace(/^devcontainer-/, '') || containerName;
  return `/workspaces/${leaf}`;
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
