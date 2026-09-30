// The shape of the host folder tree the picker browses, and the path arithmetic
// that goes with it.
//
// The tree is grown one folder at a time: the API answers with the contents of
// exactly one directory, so a node starts unloaded and fills in when it is
// opened. That is the whole reason `loaded` exists — an empty `children` means
// "we have not looked yet" until it does, and those two are not the same thing
// to a twisty.
//
// The path helpers stay pure string work: hosts spell paths differently
// (`T:\\projects`, `//server/share`, `/home/me`) and the picker has to render,
// compare and walk up them without asking the server.

export interface FolderNode {
  /** Full host path, in the same notation the API returns. */
  path: string;
  /** The segment shown in the tree ('huddle'), or the root ('T:', '/'). */
  name: string;
  /** False until this folder's children have been fetched. */
  loaded: boolean;
  children: FolderNode[];
}

export interface FolderRow {
  node: FolderNode;
  depth: number;
  open: boolean;
  /** Whether to draw a twisty: yes when it has children or might still have. */
  canExpand: boolean;
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
 * purpose: the depth of this tree is however deep the operator has browsed,
 * which nothing bounds, so a recursive walk would put a hostile or merely absurd
 * folder layout in charge of our call stack (CWE-674).
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
 * 'T:/projects' that came back from the API.
 */
export function canonicalPath(path: string): string {
  const { root, rest } = splitRoot(path);
  if (!rest.length) return root;
  return root.endsWith('/') ? `${root}${rest.join('/')}` : `${root}/${rest.join('/')}`;
}

/** A folder we know about but have not looked inside yet. */
export function makeNode(path: string, name: string): FolderNode {
  return { path, name, loaded: false, children: [] };
}

/**
 * Fills a node with what the API just listed, keeping the children that are
 * already there.
 *
 * Reusing an existing child rather than replacing it keeps everything below it
 * loaded, so re-listing a folder does not collapse the branch you came from.
 * Children that are gone from the host disappear here too — that is the point of
 * looking live.
 */
export function setChildren(node: FolderNode, entries: readonly { path: string; name: string }[]): void {
  const existing = new Map(node.children.map((c) => [c.path.toLowerCase(), c]));
  node.children = entries.map((e) => existing.get(e.path.toLowerCase()) ?? makeNode(e.path, e.name));
  node.loaded = true;
}

/** The node for an exact path, or null when that branch is not loaded. */
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

// Marks every node whose subtree contains a hit, in one bottom-up pass: each node
// is tested exactly once and then only has to look at its own children, which are
// already decided. Asking the question per node instead — walk this node's
// subtree, then walk each child's subtree again — re-reads the same nodes once
// per ancestor, so a deeply browsed tree makes every keystroke quadratic.
function subtreeHits(tree: readonly FolderNode[], query: string): Set<FolderNode> {
  const all = flattenNodes(tree); // pre-order, so a node always precedes its children
  const hits = new Set<FolderNode>();
  for (let i = all.length - 1; i >= 0; i--) {
    const node = all[i];
    if (matches(node, query) || node.children.some((c) => hits.has(c))) hits.add(node);
  }
  return hits;
}

/**
 * Flattens the tree to the rows that are actually visible. Flat rows keep the
 * template free of recursion and make the panel cheap to re-render.
 *
 * While filtering, a branch that contains a hit opens itself: a filter that
 * needs manual expanding to show its results is no filter at all. The filter
 * only sees what has been loaded — it narrows the folders on screen, it does not
 * search the host, which would mean walking the whole filesystem per keystroke.
 */
export function folderRows(
  tree: readonly FolderNode[],
  expanded: ReadonlySet<string>,
  query = '',
): FolderRow[] {
  const q = query.trim().toLowerCase();
  const rows: FolderRow[] = [];
  const hits = q ? subtreeHits(tree, q) : null;

  // Iterative for the same reason as flattenNodes: with a filter active every
  // branch holding a hit opens itself, so the walk follows the full depth of
  // what has been loaded. Children are pushed in reverse so they pop in tree order.
  const stack: { node: FolderNode; depth: number }[] = [];
  const push = (nodes: readonly FolderNode[], depth: number): void => {
    for (let i = nodes.length - 1; i >= 0; i--) stack.push({ node: nodes[i], depth });
  };

  push(tree, 0);
  while (stack.length) {
    const { node, depth } = stack.pop() as { node: FolderNode; depth: number };
    if (hits && !hits.has(node)) continue;
    const openByFilter = hits !== null && node.children.some((c) => hits.has(c));
    const open = openByFilter || expanded.has(node.path.toLowerCase());
    rows.push({ node, depth, open, canExpand: !node.loaded || node.children.length > 0 });
    if (open) push(node.children, depth + 1);
  }
  return rows;
}
