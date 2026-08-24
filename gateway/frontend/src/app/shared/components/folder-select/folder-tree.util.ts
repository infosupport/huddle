// Turns the flat list of indexed host folders into a tree the portal can browse.
//
// The index is a flat set of absolute paths ('T:/projects/huddle'), because that
// is what `huddle indexfolder` collects and what Docker needs back. A flat list
// of a few hundred paths is unreadable, so the picker rebuilds the hierarchy
// here — client side, from the strings themselves. No extra API, and a path that
// only exists as the parent of an indexed folder still shows up as a node: it
// demonstrably exists on the host, so it is selectable too.

export interface FolderNode {
  /** Full host path, in the same notation the API stores. */
  path: string;
  /** The segment shown in the tree ('huddle'), or the root ('T:', '/'). */
  name: string;
  /** True when this exact path is in the index, false for a synthesized parent. */
  indexed: boolean;
  children: FolderNode[];
}

export interface FolderRow {
  node: FolderNode;
  depth: number;
  open: boolean;
}

/**
 * Splits a path into its root and the segments below it. The root is what you
 * cannot go above: a drive ('T:/'), a UNC share ('//server/share') or '/'.
 */
export function splitRoot(path: string): { root: string; rest: string[] } {
  const p = (path ?? '').trim().replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(p)) {
    return { root: `${p.slice(0, 1).toUpperCase()}:/`, rest: p.slice(2).split('/').filter(Boolean) };
  }
  if (p.startsWith('//')) {
    const parts = p.slice(2).split('/').filter(Boolean);
    // '//server' without a share is not a usable root, but must not crash the tree.
    return { root: `//${parts.slice(0, 2).join('/')}`, rest: parts.slice(2) };
  }
  return { root: '/', rest: p.split('/').filter(Boolean) };
}

function join(parent: string, segment: string): string {
  return parent.endsWith('/') ? `${parent}${segment}` : `${parent}/${segment}`;
}

/** All ancestors of a path, root first — used to expand the tree to a value. */
export function ancestorPaths(path: string): string[] {
  const { root, rest } = splitRoot(path);
  if (!root) return [];
  const out = [root];
  let current = root;
  for (const segment of rest.slice(0, -1)) {
    current = join(current, segment);
    out.push(current);
  }
  return out;
}

/** 'T:/projects/docs' -> 'T: / projects / docs', the way the design shows paths. */
export function prettyPath(path: string): string {
  const { root, rest } = splitRoot(path);
  if (root === '/') return `/${rest.join(' / ')}`;
  return [root.replace(/\/$/, ''), ...rest].join(' / ');
}

/**
 * The path as the API stores it: forward slashes, upper-case drive letter, no
 * trailing slash except on a root. Typing 't:\\projects\\' must match the
 * 'T:/projects' that came back from the index.
 */
export function canonicalPath(path: string): string {
  const { root, rest } = splitRoot(path);
  if (!rest.length) return root;
  return root.endsWith('/') ? `${root}${rest.join('/')}` : `${root}/${rest.join('/')}`;
}

export function buildFolderTree(paths: readonly string[]): FolderNode[] {
  const roots = new Map<string, FolderNode>();
  const byPath = new Map<string, FolderNode>();

  const nodeFor = (parent: FolderNode | null, path: string, name: string): FolderNode => {
    const existing = byPath.get(path.toLowerCase());
    if (existing) return existing;
    const node: FolderNode = { path, name, indexed: false, children: [] };
    byPath.set(path.toLowerCase(), node);
    if (parent) parent.children.push(node);
    else roots.set(path.toLowerCase(), node);
    return node;
  };

  for (const raw of paths) {
    const { root, rest } = splitRoot(raw);
    if (!root) continue;
    let node = nodeFor(null, root, root === '/' ? '/' : root.replace(/\/$/, ''));
    for (const segment of rest) node = nodeFor(node, join(node.path, segment), segment);
    node.indexed = true;
  }

  const sort = (nodes: FolderNode[]): FolderNode[] => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    for (const n of nodes) sort(n.children);
    return nodes;
  };
  return sort([...roots.values()]);
}

/** The node for an exact path, or null when the index no longer holds it. */
export function findNode(tree: readonly FolderNode[], path: string): FolderNode | null {
  if (!path) return null;
  const wanted = path.toLowerCase();
  for (const node of tree) {
    if (node.path.toLowerCase() === wanted) return node;
    const hit = findNode(node.children, path);
    if (hit) return hit;
  }
  return null;
}

/** Breadcrumb trail for a path: root first, the folder itself last. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  if (!path) return [];
  const { root, rest } = splitRoot(path);
  const out = [{ name: root === '/' ? '/' : root.replace(/\/$/, ''), path: root }];
  let current = root;
  for (const segment of rest) {
    current = join(current, segment);
    out.push({ name: segment, path: current });
  }
  return out;
}

function matches(node: FolderNode, query: string): boolean {
  return node.name.toLowerCase().includes(query) || node.path.toLowerCase().includes(query);
}

function subtreeMatches(node: FolderNode, query: string): boolean {
  return matches(node, query) || node.children.some((c) => subtreeMatches(c, query));
}

/**
 * Flattens the tree to the rows that are actually visible. Flat rows keep the
 * template free of recursion and make the panel cheap to re-render.
 *
 * While filtering, a branch that contains a hit opens itself: a filter that
 * needs manual expanding to show its results is no filter at all.
 */
export function folderRows(
  tree: readonly FolderNode[],
  expanded: ReadonlySet<string>,
  query = '',
): FolderRow[] {
  const q = query.trim().toLowerCase();
  const rows: FolderRow[] = [];

  const walk = (nodes: readonly FolderNode[], depth: number): void => {
    for (const node of nodes) {
      const hit = q ? subtreeMatches(node, q) : true;
      if (!hit) continue;
      const openByFilter = q !== '' && node.children.some((c) => subtreeMatches(c, q));
      const open = openByFilter || expanded.has(node.path.toLowerCase());
      rows.push({ node, depth, open });
      if (open) walk(node.children, depth + 1);
    }
  };

  walk(tree, 0);
  return rows;
}
