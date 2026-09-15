/**
 * Where a workspace lands inside a devcontainer.
 *
 * Pure on purpose (same reason as rules.ts): besides the start route, the CLI
 * has to know this exact path to write VS Code's attached-container config on
 * the host. The gateway returns it from POST /api/docker/start so there is one
 * source of truth and the two sides cannot drift apart.
 */

/** Host path in the shape the Docker API wants: forward slashes, no trailing slash. */
export function normalizeWorkspaceDir(workspaceDir: string | undefined | null): string {
  return (workspaceDir ?? '').replace(/\\/g, '/').replace(/\/$/, '');
}

/**
 * The mount point inside the container. An empty container has no bind mount;
 * it falls back to the container name so the folder the config script creates
 * still carries a recognisable name.
 */
export function containerWorkspacePath(
  workspaceDir: string | undefined | null,
  containerName: string,
  empty: boolean
): string {
  const fwd = normalizeWorkspaceDir(workspaceDir);
  const leaf = empty
    ? containerName.replace(/^devcontainer-/, '') || containerName
    : (fwd.split('/').pop() || containerName);
  return `/workspaces/${leaf}`;
}
