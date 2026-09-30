import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// A `requested` row may only be filed by a request that actually happened.
//
// That is what Dismiss depends on. Dismissing deletes the row, and the row is
// meant to come back the next time the host is really reached — so anything that
// files one on a TIMER, from a log or an aggregate rather than from traffic,
// makes dismissing impossible: the row returns on the next tick and no amount of
// clicking settles it.
//
// sandbox/auto-sync.ts did exactly that. It polled `sbx policy log --json` every
// 20s and filed every entry in `blocked_hosts` — a cumulative aggregate carrying
// a `count_since`, not a queue — so hosts a box had been blocked for once, long
// ago, were re-filed forever, including for boxes that no longer existed.
//
// The only writer left is control/apply.ts, reached from POST /control/report,
// i.e. from a decision the proxy already made about a real request. Operator
// routes may still set a status from a bound parameter (that is a human acting,
// not a poller), which is why this looks for the LITERAL only.
//
// Static, like boot-graph.test.ts and db-prepare-lazy.test.ts: reads sources
// rather than importing them, so it also runs where the native binding cannot be
// built.

const SRC = path.join(__dirname, '..', 'src');

/** Files allowed to hard-code an INSERT of a `requested` rule. */
const ALLOWED = ['control/apply.ts'];

function tsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return tsFiles(full);
    return e.isFile() && e.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Does this source hard-code an INSERT into `rules` with a literal 'requested'?
 *
 * The status may sit anywhere in the statement — a column default, a VALUES
 * literal, a SELECT — so the window after the INSERT is what gets searched,
 * bounded so the next unrelated statement cannot be read as part of this one.
 */
export function filesRequestedLiteral(src: string): boolean {
  const insert = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+rules\b/gi;
  for (let m = insert.exec(src); m !== null; m = insert.exec(src)) {
    const window = src.slice(m.index, m.index + 400).split(';')[0];
    if (/'requested'/.test(window)) return true;
  }
  return false;
}

describe('who may file a requested rule', () => {
  it('only the control report writes one', () => {
    const offenders = tsFiles(SRC)
      .filter((file) => filesRequestedLiteral(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SRC, file).split(path.sep).join('/'));
    expect(offenders.sort()).toEqual(ALLOWED);
  });

  it('recognises the shape of the ingest it exists to keep out', () => {
    const ingest =
      "const stmt = db.prepare(\n" +
      "  `INSERT OR IGNORE INTO rules (domain, container_id, status) VALUES (?, ?, 'requested')`\n" +
      ');\n';
    const operatorRoute =
      "db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES (?, ?, ?)`).run(d, c, status);\n";
    expect(filesRequestedLiteral(ingest)).toBe(true);
    expect(filesRequestedLiteral(operatorRoute)).toBe(false);
  });

  it('does not read a following statement as part of the insert', () => {
    const src =
      "db.prepare(`INSERT INTO rules (domain) VALUES (?)`);\n" +
      "db.prepare(`SELECT * FROM rules WHERE status = 'requested'`);\n";
    expect(filesRequestedLiteral(src)).toBe(false);
  });
});
