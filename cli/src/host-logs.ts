import fs from 'fs';
import path from 'path';
import type { HuddleConfig } from './config';

/** Must match HOST_AGENT_LOGS_MOUNT in gateway/src/host-config.ts. */
export const HOST_AGENT_LOGS_MOUNT = '/host-logs/claude/projects';
/** Must match HOST_CODEX_LOGS_MOUNT in gateway/src/host-config.ts. */
export const HOST_CODEX_LOGS_MOUNT = '/host-logs/codex/sessions';
/** Extensions read the Codex index here; the gateway itself never opens it. */
export const HOST_CODEX_INDEX_MOUNT = '/host-logs/codex/session_index.jsonl';

/** A real directory only: Docker follows a symlinked source, which could point the mount at ~/.claude itself. */
const isPlainDir = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * `docker run` args that expose the host's Claude session logs to extensions:
 * only ~/.claude/projects, read-only — never ~/.claude itself, which holds credentials.
 */
export function hostAgentLogsMountArgs(
  cfg: Pick<HuddleConfig, 'hostAgentLogs'>,
  homeDir: string,
  exists: (p: string) => boolean = isPlainDir,
): string[] {
  if (cfg.hostAgentLogs !== true) return [];
  const projects = path.join(homeDir, '.claude', 'projects');
  return exists(projects) ? ['-v', `${projects}:${HOST_AGENT_LOGS_MOUNT}:ro`] : [];
}

/** The same for Codex: only ~/.codex/sessions, read-only — never ~/.codex itself, which holds auth.json. */
export function hostCodexLogsMountArgs(
  cfg: Pick<HuddleConfig, 'hostAgentLogs'>,
  homeDir: string,
  exists: (p: string) => boolean = isPlainDir,
): string[] {
  if (cfg.hostAgentLogs !== true) return [];
  const sessions = path.join(homeDir, '.codex', 'sessions');
  return exists(sessions) ? ['-v', `${sessions}:${HOST_CODEX_LOGS_MOUNT}:ro`] : [];
}

/** A plain file only: a symlink or hard link here could point the mount at auth.json. */
const isPlainFile = (p: string): boolean => {
  try {
    const stat = fs.lstatSync(p);
    return stat.isFile() && stat.nlink === 1;
  } catch {
    return false;
  }
};

/** Codex keeps thread names in ~/.codex/session_index.jsonl; only that file is mounted, read-only. */
export function hostCodexIndexMountArgs(
  cfg: Pick<HuddleConfig, 'hostAgentLogs'>,
  homeDir: string,
  exists: (p: string) => boolean = isPlainFile,
): string[] {
  if (cfg.hostAgentLogs !== true) return [];
  const index = path.join(homeDir, '.codex', 'session_index.jsonl');
  return exists(index) ? ['-v', `${index}:${HOST_CODEX_INDEX_MOUNT}:ro`] : [];
}
