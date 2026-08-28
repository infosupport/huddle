import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { scanHostFolders, scanRootProblem, MAX_SCAN_FOLDERS } from '../src/host-scan';

// The host walk behind `huddle indexfolder` and the portal's Scan button. It
// moved out of the CLI when Huddle Node started running on the host, so the
// properties that made it safe to run over an operator's projects folder are
// asserted here rather than trusted.

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-scan-'));
  fs.mkdirSync(path.join(root, 'app', 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'app', 'node_modules', 'left-pad'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'app', 'README.md'), '# not a folder');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const rel = (folders: string[]) => folders.map((f) => path.relative(root, f)).sort();

describe('scanHostFolders', () => {
  it('returns the root plus its folders, breadth-first to the given depth', () => {
    expect(rel(scanHostFolders(root, 1, false).folders)).toEqual(['', 'app', 'lib']);
    expect(rel(scanHostFolders(root, 2, false).folders)).toEqual(['', 'app', path.join('app', 'src'), 'lib']);
  });

  it('indexes only the root at depth 0', () => {
    expect(scanHostFolders(root, 0, false).folders).toEqual([root]);
  });

  it('skips build folders and hidden folders, and files', () => {
    const found = rel(scanHostFolders(root, 3, false).folders);
    expect(found).not.toContain('.git');
    expect(found.some((f) => f.includes('node_modules'))).toBe(false);
    expect(found).not.toContain(path.join('app', 'README.md'));
  });

  it('includes build folders with `all`, but never hidden ones', () => {
    const found = rel(scanHostFolders(root, 3, true).folders);
    expect(found).toContain(path.join('app', 'node_modules'));
    expect(found).not.toContain('.git');
  });

  it('reports a non-existent or non-directory root instead of throwing', () => {
    expect(scanRootProblem(root)).toBeNull();
    expect(scanRootProblem(path.join(root, 'nope'))).toMatch(/does not exist/);
    expect(scanRootProblem(path.join(root, 'app', 'README.md'))).toMatch(/not a folder/);
  });

  it('stops at the ceiling rather than walking a whole drive', () => {
    const wide = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-wide-'));
    try {
      for (let i = 0; i < MAX_SCAN_FOLDERS + 10; i++) fs.mkdirSync(path.join(wide, `d${i}`));
      const res = scanHostFolders(wide, 1, false);
      expect(res.truncated).toBe(true);
      expect(res.folders.length).toBe(MAX_SCAN_FOLDERS);
    } finally {
      fs.rmSync(wide, { recursive: true, force: true });
    }
  });
});
