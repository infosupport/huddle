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
