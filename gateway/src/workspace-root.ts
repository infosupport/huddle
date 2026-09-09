// Picking the IDE project root for a multi-mount devcontainer.
//
// Pure path arithmetic, kept out of api.ts so it can be unit-tested without a
// Fastify app, a database or a Docker daemon.

// Deepest directory that every given absolute path sits under (their longest
// shared prefix at a path-segment boundary). Returns '' for no paths at all and
// '/' when the paths share no leading segment.
export function commonParentPath(paths: string[]): string {
  if (paths.length === 0) return '';
  const split = paths.map((p) => p.split('/').filter(Boolean));
  const first = split[0];
  const shared: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (split.every((parts) => parts[i] === seg)) shared.push(seg);
    else break;
  }
  return '/' + shared.join('/');
}

// The IDE project root for a multi-mount container when the caller supplied no
// explicit "open at" path (e.g. an older CLI): the deepest directory all mounts
// share. commonParentPath() bottoms out at '/' when the mounts share no leading
// segment, and at '' when there is nothing to compare — neither is a usable
// project root, so both fall through to the documented '/workspaces' default. A
// plain `commonParentPath(...) || '/workspaces'` would only ever catch the ''
// case, leaving unrelated mounts rooted at '/'.
export function defaultMultiMountWorkspace(containerPaths: string[]): string {
  const common = commonParentPath(containerPaths);
  return common === '' || common === '/' ? '/workspaces' : common;
}

// Everything a container path must satisfy before the gateway acts on it, as a
// human-readable complaint (null = fine).
//
// These values do not stay data: docker.ts interpolates the workspace root into
// the container setup script, which runs as root via `sh -c`, and then does
// `mkdir -p` / `chown -R` / `chmod -R` on it. Two consequences drive the rules
// below:
//  - '/' is rejected outright. It is a perfectly well-formed path, but as a
//    project root it turns the permission fix-up into `chown -R vscode:vscode /`
//    over the whole container filesystem.
//  - shell metacharacters are rejected even though docker.ts now single-quotes
//    the value as well. Two independent layers: neither one silently becomes the
//    only thing standing between a request body and root in the container.
// Traversal segments and control characters have no legitimate use in a path the
// operator picks in the modal, so they are refused rather than normalised away.
export function containerPathError(p: string): string | null {
  if (!p.startsWith('/')) return 'must be an absolute path';
  if (p.length > 512) return 'must be at most 512 characters';
  if (/[\x00-\x1f\x7f]/.test(p)) return 'must not contain control characters';
  if (/["'`$\\]/.test(p)) return 'must not contain quotes, backticks, $ or backslashes';
  const segments = p.split('/').filter(Boolean);
  if (segments.length === 0) return "must not be the container root '/'";
  if (segments.some((s) => s === '.' || s === '..')) return "must not contain '.' or '..' segments";
  return null;
}
