// ── Settings folders (folder mappings) → sbx sandboxes ────────────────────────
// Huddle's "Folder mappings" (Settings page, `~/.huddle/config.json`) are the
// team's settings folders: an agent's config/skills/instructions folder that must
// be present in EVERY dev environment. Devcontainers get them as Docker mounts
// (docker.ts buildFolderMounts). Sandboxes could not, because sbx has no
// `--mount host:container`: it mounts each workspace path INSIDE the sandbox at
// the SAME path it has on the host (`sbx create AGENT PATH [PATH...]`, `:ro` for
// read-only).
//
// So a sandbox gets a mapping in two moves:
//   1. the host folder rides along as an extra workspace on `sbx create`
//      (read-only mappings keep sbx's `:ro`);
//   2. one `sbx exec` afterwards links it from the path the agent looks at
//      (the mapping's container path, rewritten to the sandbox user's $HOME).
//
// The link step NEVER overwrites what is already in the sandbox. sbx manages the
// agent's own credential state under $HOME (e.g. ~/.claude), so an existing target
// folder is kept and only its MISSING entries are linked in. That way a mapping
// adds CLAUDE.md / agents / skills without touching a token sbx put there.
//
// Everything here is pure (mappings in, plan + script out) so it is unit-testable
// without sbx, Docker or the host config; sbx.ts reads the mappings and runs the script.

import type { HostFolderMapping } from '../host-config';
import { normalizeWorkspacePath, type WorkspaceSpec } from './protocol';

/** One mapping, resolved for a sandbox. */
export interface SandboxSettingsFolder {
  /** Mapping name, for the operator-facing report. */
  name: string;
  /** Host path, as `sbx create` receives it (Windows or POSIX). */
  hostPath: string;
  /** Where sbx mounts it inside the sandbox (same path as on the host). */
  mountPath: string;
  /** Where the agent expects it: the container path, `~/` when under $HOME. */
  targetPath: string;
  readOnly: boolean;
}

export interface SandboxSettingsPlan {
  folders: SandboxSettingsFolder[];
  /** Mappings that cannot travel to a sandbox, with the reason to report. */
  skipped: { name: string; reason: string }[];
}

/**
 * Home directories the devcontainer images use. A mapping is written for those
 * (`/home/vscode/.claude`), while an sbx sandbox runs as its own user (`agent`),
 * so the target is re-anchored on $HOME instead of a hard-coded home.
 */
const CONTAINER_HOMES = ['/home/vscode', '/home/node', '/home/agent', '/root'];

/**
 * Where a host folder shows up INSIDE a sandbox. sbx mounts a workspace at the
 * same path as on the host, which for a Windows drive path means the MSYS form:
 * `T:\projects\huddle` on the host is `/t/projects/huddle` in the sandbox (the
 * same translation bridge/sbx-watcher.sh does in reverse for argv).
 *
 * Returns null for anything whose sandbox path we cannot know: relative paths,
 * `~`-paths (only the host shell knows that home) and UNC shares.
 */
export function hostPathToSandboxPath(hostPath: unknown): string | null {
  if (typeof hostPath !== 'string') return null;
  const raw = hostPath.trim();
  if (!raw) return null;
  if (raw.startsWith('\\\\') || raw.startsWith('//')) return null; // UNC share
  if (raw.startsWith('~')) return null;                            // host-shell home
  if (raw.startsWith('/')) return raw.replace(/\/+$/, '') || '/';   // already POSIX

  const drive = /^([a-zA-Z]):[/\\](.*)$/.exec(raw);
  if (!drive) return null;                                         // relative path
  const rest = drive[2].replace(/\\/g, '/').replace(/\/+$/, '');
  return `/${drive[1].toLowerCase()}${rest ? `/${rest}` : ''}`;
}

/**
 * The mapping's container path as an sbx link target: `/home/vscode/.claude` →
 * `~/.claude` (expanded to the sandbox user's real home by the link script), any
 * other absolute path stays itself. Returns null when the path cannot be linked
 * safely — not absolute, a home directory itself, or carrying a character the
 * link script would have to quote (`$`, backtick, quote, backslash, `|`, `..`).
 */
export function sandboxSettingsTarget(containerPath: unknown): string | null {
  if (typeof containerPath !== 'string') return null;
  const p = containerPath.trim().replace(/\/+$/, '');
  if (!p.startsWith('/') || p.length < 2) return null;
  if (/["'`$\\|]/.test(p) || /[\r\n\u0000]/.test(p)) return null;
  if (p.split('/').includes('..')) return null;

  for (const home of CONTAINER_HOMES) {
    if (p === home) return null;                    // never link over the whole home
    if (p.startsWith(`${home}/`)) return `~/${p.slice(home.length + 1)}`;
  }
  return p;
}

/**
 * Turn the folder-mapping rows into the sandbox plan. Enabled mappings with a
 * usable host path travel; the rest are reported so the operator sees WHY a
 * mapping that works for devcontainers did not reach the sandbox:
 *   - a Docker volume has no host folder for sbx to mount;
 *   - a `~`/relative/UNC host path has no knowable path inside the sandbox;
 *   - a container path we cannot link safely.
 * Disabled rows are silent — they are off for devcontainers too.
 */
export function planSettingsFolders(mappings: HostFolderMapping[]): SandboxSettingsPlan {
  const folders: SandboxSettingsFolder[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const seenTargets = new Set<string>();

  for (const m of mappings) {
    if (!m.enabled) continue;
    const name = (m.name || m.containerPath || '(unnamed)').trim();
    const hostPath = (m.hostPath || '').trim();

    if (!hostPath) {
      skipped.push({
        name,
        reason: m.volumeName
          ? `Docker volume '${m.volumeName.trim()}' — a sandbox can only mount host folders`
          : 'no host path configured',
      });
      continue;
    }
    const mountPath = hostPathToSandboxPath(hostPath);
    if (!mountPath) {
      skipped.push({ name, reason: `host path '${hostPath}' is not an absolute host path (use e.g. C:\\Users\\me\\.claude)` });
      continue;
    }
    const targetPath = sandboxSettingsTarget(m.containerPath);
    if (!targetPath) {
      skipped.push({ name, reason: `container path '${m.containerPath}' cannot be linked in a sandbox` });
      continue;
    }
    if (/[|]/.test(mountPath) || /[\r\n\u0000"'`$\\]/.test(mountPath)) {
      skipped.push({ name, reason: `host path '${hostPath}' contains a character the sandbox link step cannot handle` });
      continue;
    }
    if (seenTargets.has(targetPath)) {
      skipped.push({ name, reason: `another mapping already targets ${targetPath}` });
      continue;
    }
    seenTargets.add(targetPath);
    folders.push({ name, hostPath, mountPath, targetPath, readOnly: m.readOnly });
  }
  return { folders, skipped };
}

/** The extra `sbx create` workspaces for a plan, in mapping order. */
export function settingsWorkspaces(plan: SandboxSettingsPlan): { path: string; readOnly: boolean }[] {
  return plan.folders.map((f) => ({ path: f.hostPath, readOnly: f.readOnly }));
}

/**
 * The folder list a sandbox is created with: the folders the caller asked for
 * first (the FIRST one is the primary — where the agent starts), then the settings
 * folders. Duplicates are dropped by normalized path (sbx refuses the same folder
 * twice, and a settings folder may well be one the caller also asked for): the
 * primary wins, then first occurrence. `fallback` is used when nothing was asked.
 */
export function mergeSandboxWorkspaces(
  requested: WorkspaceSpec[],
  plan: SandboxSettingsPlan,
  fallback: string,
): { primary: WorkspaceSpec; extras: WorkspaceSpec[] } {
  const asked = requested
    .filter((w) => typeof w?.path === 'string' && w.path.trim() !== '')
    .map((w) => ({ path: w.path.trim(), readOnly: w.readOnly === true }));
  if (asked.length === 0) asked.push({ path: fallback.trim(), readOnly: false });

  const [primary, ...rest] = asked;
  const seen = new Set([normalizeWorkspacePath(primary.path)]);
  const extras: WorkspaceSpec[] = [];
  for (const w of [...rest, ...settingsWorkspaces(plan)]) {
    const norm = normalizeWorkspacePath(w.path);
    if (seen.has(norm)) continue;
    seen.add(norm);
    extras.push({ path: w.path, readOnly: w.readOnly === true });
  }
  return { primary, extras };
}

/**
 * The `sh -c` script that links every mounted settings folder to its target.
 *
 * IMPORTANT: a SINGLE LINE, no embedded newlines — the container-side `sbx` is a
 * file mailbox that passes argv one argument per line (bridge/sbx.sh), so a
 * multi-line argument would be split. Entries are `name|mount|target` records;
 * every field is validated by planSettingsFolders to contain no `|`, quote, `$`,
 * backslash or newline, so single-quoting each record is safe.
 *
 * Per folder:
 *   - mount missing            → SKIP (sbx did not mount it; the create step says why)
 *   - target is a symlink      → RELINK (re-point it, ours from a previous start)
 *   - target is a non-empty dir→ MERGE: link only the entries it does not have yet
 *   - target is an empty dir   → replace it with the symlink
 *   - target is a file         → KEEP (never clobber a real file)
 *   - otherwise                → LINK the whole folder
 */
export function buildSettingsFolderScript(folders: SandboxSettingsFolder[]): string {
  if (folders.length === 0) return '';
  const records = folders.map((f) => `'${f.name.replace(/[|'\r\n]/g, ' ')}|${f.mountPath}|${f.targetPath}'`).join(' ');
  return (
    `for e in ${records}; do ` +
    `n=\${e%%|*}; r=\${e#*|}; m=\${r%%|*}; g=\${r#*|}; ` +
    // `\~` is escaped on purpose: an unquoted `~` inside ${g#...} is tilde-EXPANDED
    // by the shell, so the prefix would never match and the target would end up as
    // "$HOME/~/.claude".
    `case "$g" in "~/"*) t="$HOME/\${g#\\~/}";; *) t="$g";; esac; ` +
    `if [ ! -e "$m" ]; then echo "huddle-settings: SKIP $n (not mounted at $m)"; continue; fi; ` +
    `if [ -L "$t" ]; then ln -sfn "$m" "$t" && echo "huddle-settings: RELINK $n -> $t"; continue; fi; ` +
    `if [ -d "$t" ]; then ` +
    `if [ -z "$(ls -A "$t" 2>/dev/null)" ]; then rmdir "$t" 2>/dev/null; ` +
    `else k=0; for c in "$m"/* "$m"/.[!.]*; do [ -e "$c" ] || continue; b=\${c##*/}; ` +
    `if [ -e "$t/$b" ] || [ -L "$t/$b" ]; then continue; fi; ln -sfn "$c" "$t/$b" && k=$((k+1)); done; ` +
    `echo "huddle-settings: MERGE $n -> $t ($k new entries linked, existing ones kept)"; continue; fi; ` +
    `elif [ -e "$t" ]; then echo "huddle-settings: KEEP $n ($t is an existing file)"; continue; fi; ` +
    `mkdir -p "$(dirname "$t")" && ln -sfn "$m" "$t" && echo "huddle-settings: LINK $n -> $t" ` +
    `|| echo "huddle-settings: FAIL $n ($t)"; ` +
    `done`
  );
}
