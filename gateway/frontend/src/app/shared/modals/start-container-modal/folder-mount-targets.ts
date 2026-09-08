// Pure, framework-free: the create-modal computes container-path previews on
// every keystroke and again at submit time, and both call this so there is
// exactly one place that decides what `/workspaces/<leaf>` means. No
// Angular/DOM/HTTP dependency — takes host paths, returns targets, testable
// with a plain array in, array out.

/**
 * The trailing path segment a host path would mount as, e.g.
 * `C:\projects\my-app\` -> `my-app`. Returns '' when there is nothing usable
 * (blank input, or a bare drive root like `C:` / `C:\`), so the caller can
 * fall back to a generic name instead of mounting at `/workspaces/C:`.
 */
function leafOf(hostPath: string): string {
  const normalized = (hostPath ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const leaf = normalized.split('/').filter(Boolean).pop() ?? '';
  return leaf.endsWith(':') ? '' : leaf;
}

/**
 * Computes the `/workspaces/<leaf>` target for each host path, in row order.
 *
 * Two rows whose leaf would collide (same basename, or both falling back to
 * the generic "project" name) get `-2`, `-3`, … appended in the order they
 * appear — the first row to claim a name keeps it undecorated. This is the
 * single source of truth for container-path targets: the modal calls it for
 * the live per-row preview and again, unchanged, at submit time.
 */
export function computeMountTargets(hostPaths: string[]): string[] {
  const seenCount = new Map<string, number>();
  return hostPaths.map((hostPath) => {
    const base = leafOf(hostPath) || 'project';
    const count = (seenCount.get(base) ?? 0) + 1;
    seenCount.set(base, count);
    const name = count === 1 ? base : `${base}-${count}`;
    return `/workspaces/${name}`;
  });
}
