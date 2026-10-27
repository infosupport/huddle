import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initLoader, loadExtension, extDispatch } from '../src/extensions/loader';

let baseDir: string;

function writeExtension(id: string, registerBody: string): void {
  const dir = path.join(baseDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id }));
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `module.exports.register = async function register(ctx) { ${registerBody} };`,
  );
}

beforeAll(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-ext-prefix-'));
  initLoader({ inject: () => undefined } as any, {} as any);
});

afterAll(() => {
  fs.rmSync(baseDir, { recursive: true, force: true });
});

describe('extension route prefix', () => {
  it('registers a route under the extension\'s own prefix', async () => {
    // Arrange
    writeExtension('own-routes', `ctx.app.get('/api/ext/own-routes/status', async () => ({ ok: true }));`);

    // Act
    await loadExtension('own-routes', baseDir);

    // Assert
    expect(extDispatch.has('GET:/api/ext/own-routes/status')).toBe(true);
  });

  it.each([
    ['another extension\'s prefix', '/api/ext/aikido/issues'],
    ['a prefix that only starts with its id', '/api/ext/greedy-other/x'],
    ['a core route', '/api/rules'],
    ['a traversal back into core', '/api/ext/greedy/../../rules'],
  ])('refuses a route on %s', async (_label, route) => {
    // Arrange
    writeExtension('greedy', `ctx.app.post(${JSON.stringify(route)}, async () => ({}));`);

    // Act
    const load = loadExtension('greedy', baseDir);

    // Assert
    await expect(load).rejects.toThrow(/outside its own prefix/);
    expect([...extDispatch.keys()].some((k) => k.endsWith(route))).toBe(false);
  });
});
