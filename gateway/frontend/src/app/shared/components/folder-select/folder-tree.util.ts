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

/**
 * Every node in the tree, parents before children (pre-order). Iterative on
 * purpose: the depth of this tree is the segment depth of an indexed host path,
 * which nothing on the write side bounds, so a recursive walk would put a
 * hostile or merely absurd path in charge of our call stack (CWE-674).
 */
export function flattenNodes(nodes: readonly FolderNode[]): FolderNode[] {
  const out: FolderNode[] = [];
  const stack: FolderNode[] = [...nodes].reverse();
  while (stack.length) {
    const node = stack.pop() as FolderNode;
    out.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return out;
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

  const byName = (a: FolderNode, b: FolderNode): number =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const tree = [...roots.values()];
  for (const node of flattenNodes(tree)) node.children.sort(byName);
  return tree.sort(byName);
}

/** The node for an exact path, or null when the index no longer holds it. */
export function findNode(tree: readonly FolderNode[], path: string): FolderNode | null {
  if (!path) return null;
  const wanted = path.toLowerCase();
  return flattenNodes(tree).find((n) => n.path.toLowerCase() === wanted) ?? null;
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

// Iterative like flattenNodes, but with its own stack: this runs once per node
// per keystroke, so it stops at the first hit instead of materialising the whole
// subtree first.
function subtreeMatches(node: FolderNode, query: string): boolean {
  const stack: FolderNode[] = [node];
  while (stack.length) {
    const n = stack.pop() as FolderNode;
    if (matches(n, query)) return true;
    for (const c of n.children) stack.push(c);
  }
  return false;
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

  // Iterative for the same reason as flattenNodes: with a filter active every
  // branch holding a hit opens itself, so the walk follows the full depth of the
  // indexed paths. Children are pushed in reverse so they pop in tree order.
  const stack: { node: FolderNode; depth: number }[] = [];
  const push = (nodes: readonly FolderNode[], depth: number): void => {
    for (let i = nodes.length - 1; i >= 0; i--) stack.push({ node: nodes[i], depth });
  };

  push(tree, 0);
  while (stack.length) {
    const { node, depth } = stack.pop() as { node: FolderNode; depth: number };
    if (q && !subtreeMatches(node, q)) continue;
    const openByFilter = q !== '' && node.children.some((c) => subtreeMatches(c, q));
    const open = openByFilter || expanded.has(node.path.toLowerCase());
    rows.push({ node, depth, open });
    if (open) push(node.children, depth + 1);
  }
  return rows;
}
