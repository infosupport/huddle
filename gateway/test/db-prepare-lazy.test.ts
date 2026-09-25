import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// No prepared statement may be built at module scope.
//
// SQLite validates SQL against the LIVE schema inside .prepare(), and the
// schema is created by initDb() — an explicit call, made at the top of bootNode().
// Imports are hoisted, so every module in the boot graph runs its top level BEFORE
// that call: a module-scope `db.prepare(...)` therefore throws
// `SqliteError: no such table: …` on a database that has never been initialised.
//
// The failure is invisible in normal use — the gateway's database lived in a
// long-lived volume that already had the schema — and fatal on exactly the boot
// that matters: the first one, on a user's host, after the Node split moved the
// database to ~/.huddle. sandbox/auto-sync.ts shipped this bug, in an ingest
// that has since been removed; prepare lazily and it cannot come back.
//
// Static, like boot-graph.test.ts: reads sources rather than importing them, so it
// also runs where the native binding cannot be built.

const SRC = path.join(__dirname, '..', 'src');

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(full);
    return e.isFile() && e.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Line numbers (1-based) of every `.prepare(` sitting at brace depth 0.
 *
 * Depth is counted over source with comments and string/template bodies blanked
 * out, so a brace inside a SQL literal or a `//` note cannot shift it.
 */
function topLevelPrepares(src: string): number[] {
  const hits: number[] = [];
  let depth = 0;
  let line = 1;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i++;
        else if (src[i] === '\n') line++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; continue; }
    if (depth === 0 && src.startsWith('.prepare', i)) { hits.push(line); i += 8; continue; }
    i++;
  }
  return hits;
}

describe('prepared statements are built lazily', () => {
  it('no gateway source prepares a statement at module scope', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      for (const line of topLevelPrepares(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(SRC, file)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('detects the shape of the bug it exists to prevent', () => {
    const bad = "import { db } from '../db';\nconst ins = db.prepare<[string]>(\n  `INSERT INTO rules (domain) VALUES (?)`\n);\n";
    const good = "let _ins = null;\nfunction ins() {\n  if (!_ins) _ins = db.prepare(`INSERT INTO rules (domain) VALUES (?)`);\n  return _ins;\n}\n";
    expect(topLevelPrepares(bad)).toEqual([2]);
    expect(topLevelPrepares(good)).toEqual([]);
  });
});
