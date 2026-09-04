import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// What the gateway process is ALLOWED to contain.
//
// The split's security claim is not "the gateway does not call the database" —
// it is that the database, the Docker client and the API are not in the process
// at all. That is an import-graph property, and nothing else enforces it: adding
// `import { db } from './db'` to a file the proxy already imports would compile,
// pass every other test, and quietly put the database and dockerode back in
// the one process a devcontainer can reach.
//
// So this walks the graph statically from boot-gateway.ts. It reads files rather
// than importing them, so it never opens a database or reaches for a Docker
// daemon of its own.

const SRC = path.join(__dirname, '..', 'src');

/** Modules the gateway must never reach, by src-relative path without extension. */
const FORBIDDEN = ['db', 'docker', 'api', 'terminal', 'pty-manager', 'socket-proxy', 'boot-node'];

function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // node builtin or dependency
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Every relative import in a file, minus the type-only ones: `import type …`
 * and `import { type X }` are erased by the compiler and put nothing in the
 * process. That distinction is load-bearing here — control/feed.ts legitimately
 * imports types from db-types.ts.
 */
function importsOf(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const specs: string[] = [];
  const re = /(?:^|\n)\s*import\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const clause = m[1];
    if (/^type\b/.test(clause.trim())) continue;
    specs.push(m[2]);
  }
  // Dynamic imports count: they load at runtime just the same.
  const dyn = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dyn.exec(src)) !== null) specs.push(m[1]);
  return specs;
}

function walk(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>(); // file → path taken to reach it
  const queue: { file: string; trail: string[] }[] = [{ file: entry, trail: [path.basename(entry)] }];
  while (queue.length) {
    const { file, trail } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.set(file, trail);
    for (const spec of importsOf(file)) {
      const target = resolveImport(file, spec);
      if (target && !seen.has(target)) {
        queue.push({ file: target, trail: [...trail, path.relative(SRC, target)] });
      }
    }
  }
  return seen;
}

describe('the gateway process boundary', () => {
  const graph = walk(path.join(SRC, 'boot-gateway.ts'));

  it.each(FORBIDDEN)('never reaches ./%s', (mod) => {
    const target = path.join(SRC, `${mod}.ts`);
    const trail = graph.get(target);
    expect(trail, trail ? `reached via ${trail.join(' → ')}` : undefined).toBeUndefined();
  });

  it('still reaches the things it is FOR, so the walk is not vacuously passing', () => {
    for (const mod of ['proxy.ts', 'tls-ca.ts', 'control/client.ts', 'control/select.ts', 'proxy-self.ts']) {
      expect(graph.has(path.join(SRC, mod)), `expected boot-gateway to reach ${mod}`).toBe(true);
    }
  });

  it('the same walk DOES reach the database from boot-node.ts', () => {
    // The control: if this ever stops holding, the walk is broken rather than
    // the boundary being clean.
    const node = walk(path.join(SRC, 'boot-node.ts'));
    expect(node.has(path.join(SRC, 'db.ts'))).toBe(true);
    expect(node.has(path.join(SRC, 'docker.ts'))).toBe(true);
  });

  it('index.ts reaches neither boot half statically — it dispatches on the role', () => {
    // A static import of either boot file would defeat the whole arrangement:
    // the gateway would load Huddle Node's graph before deciding not to run it.
    const specs = importsOf(path.join(SRC, 'index.ts'));
    const statics = specs.filter((s) => s.includes('boot-'));
    const src = fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8');
    for (const spec of statics) {
      expect(src).toMatch(new RegExp(`import\\(\\s*['"]${spec.replace('.', '\\.')}['"]`));
    }
    expect(statics).toEqual(expect.arrayContaining(['./boot-gateway', './boot-node']));
  });
});
