import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

/**
 * VS Code's "Attach to Running Container" decides which folder to open from an
 * *attached container configuration file* on the host, and from nothing else:
 * the Dev Containers extension reads `nameConfigs/<container>.json` first and
 * falls back to `imageConfigs/<image>.json`; when neither holds a
 * `workspaceFolder` it opens an empty window. Container labels play no part in
 * that decision — `devcontainer.metadata` is only consumed by the build flow,
 * and its merge drops every property outside the image-metadata spec (which
 * does not include `workspaceFolder`).
 *
 * So huddle writes the per-container config itself. Per container, never per
 * image: an image-level file would pin one workspace path for every container
 * started from the same base image.
 */

const EXT_DIR = 'ms-vscode-remote.remote-containers';

/** VS Code's own escaping for config file names (see `nameConfigs` lookup). */
function encodeConfigName(containerName: string): string {
  return containerName.replace(/[:/%]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
}

/**
 * User-data directories of the installed VS Code flavours — the directory that
 * holds `User/`, i.e. what `code --user-data-dir` points at. Insiders keeps its
 * own tree, and a Flatpak install relocates the whole thing.
 */
function userDataDirCandidates(): string[] {
  const override = process.env.HUDDLE_VSCODE_USER_DIR?.trim();
  if (override) return [override];

  const home = os.homedir();
  const dirs: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(appData, 'Code'), path.join(appData, 'Code - Insiders'));
  } else if (process.platform === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support');
    dirs.push(path.join(support, 'Code'), path.join(support, 'Code - Insiders'));
  } else {
    dirs.push(path.join(home, '.config', 'Code'), path.join(home, '.config', 'Code - Insiders'));
    dirs.push(path.join(home, '.var', 'app', 'com.visualstudio.code', 'config', 'Code'));
    dirs.push(path.join(home, '.var', 'app', 'com.visualstudio.code.insiders', 'config', 'Code - Insiders'));
    // On WSL the CLI runs in the distro while VS Code runs on Windows and reads
    // its config from %APPDATA% there, so the Linux paths above would never be
    // seen by the editor doing the attach.
    for (const appData of windowsAppDataFromWsl()) {
      dirs.push(path.join(appData, 'Code'), path.join(appData, 'Code - Insiders'));
    }
  }

  return dirs;
}

/** Best-effort %APPDATA% as seen from inside WSL; empty when not on WSL. */
function windowsAppDataFromWsl(): string[] {
  try {
    if (!fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')) return [];
    const appData = execFileSync('cmd.exe', ['/c', 'echo %APPDATA%'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: '/',
    }).trim();
    if (!appData || appData.includes('%APPDATA%')) return [];
    const unix = execFileSync('wslpath', ['-u', appData], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return unix ? [unix] : [];
  } catch {
    // No WSL interop (or cmd.exe/wslpath missing): nothing to configure there.
    return [];
  }
}

export interface AttachConfigResult {
  written: string[];
  skipped: { file: string; reason: string }[];
}

/**
 * Point every installed VS Code flavour at `workspaceFolder` when attaching to
 * `containerName`. Only flavours that already have a `User/globalStorage` tree
 * are touched — creating that tree for an editor that is not installed would
 * leave dead config behind.
 */
export function writeAttachedContainerConfig(
  containerName: string,
  workspaceFolder: string
): AttachConfigResult {
  const result: AttachConfigResult = { written: [], skipped: [] };

  for (const userDataDir of userDataDirCandidates()) {
    const globalStorage = path.join(userDataDir, 'User', 'globalStorage');
    if (!fs.existsSync(globalStorage)) continue;

    const file = path.join(globalStorage, EXT_DIR, 'nameConfigs', `${encodeConfigName(containerName)}.json`);

    let config: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          config = parsed as Record<string, unknown>;
        }
      } catch {
        // Hand-edited file with comments or a syntax error: leave it alone
        // rather than throw away settings the user put there.
        result.skipped.push({ file, reason: 'existing config is not valid JSON' });
        continue;
      }
      if (config.workspaceFolder === workspaceFolder) continue;
    }

    config.workspaceFolder = workspaceFolder;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Tab indentation matches what the extension itself writes back into
      // this file when you open another folder inside the container.
      fs.writeFileSync(file, `${JSON.stringify(config, null, '\t')}\n`);
      result.written.push(file);
    } catch (err) {
      result.skipped.push({ file, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}

/**
 * An image-level config outranks nothing (the name-level file wins) but it does
 * apply to every other container from the same base image, where its workspace
 * path does not exist. Report it so the operator can clean it up.
 */
export function findImageConfigs(imageName: string): string[] {
  const encoded = encodeConfigName(imageName);
  const found: string[] = [];
  for (const userDataDir of userDataDirCandidates()) {
    const file = path.join(userDataDir, 'User', 'globalStorage', EXT_DIR, 'imageConfigs', `${encoded}.json`);
    if (fs.existsSync(file)) found.push(file);
  }
  return found;
}
