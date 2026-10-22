import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let root: string;
let dirs: { bundled: string; uploaded: string; team: string };

function writeExtension(base: string, id: string, version: string) {
  const dir = path.join(base, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id, version }));
  fs.writeFileSync(path.join(dir, 'index.js'),
    `exports.register = async () => { (globalThis.__registered ??= []).push(${JSON.stringify(`${id}@${version}`)}); };`);
}

async function freshLoader() {
  vi.resetModules();
  const loader = await import('../src/extensions/loader');
  loader.initLoader({ inject: async () => ({}) } as any, {} as any);
  return loader;
}

const registered = () => (globalThis as any).__registered as string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-ext-folders-'));
  dirs = { bundled: path.join(root, 'bundled'), uploaded: path.join(root, 'uploaded'), team: path.join(root, 'team') };
  process.env.BUNDLED_EXT_DIR = dirs.bundled;
  process.env.EXT_DIR = dirs.uploaded;
  process.env.HUDDLE_EXTENSIONS_MOUNT = dirs.team;
  (globalThis as any).__registered = [];
});

afterEach(() => {
  delete process.env.BUNDLED_EXT_DIR;
  delete process.env.EXT_DIR;
  delete process.env.HUDDLE_EXTENSIONS_MOUNT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('extension folders', () => {
  it('loads the extensions bundled with the image and the uploaded ones', async () => {
    // Arrange
    writeExtension(dirs.bundled, 'aikido', '1.0.0');
    writeExtension(dirs.uploaded, 'notes', '0.1.0');
    const loader = await freshLoader();

    // Act
    await loader.loadAllExtensions();

    // Assert
    expect(registered().sort()).toEqual(['aikido@1.0.0', 'notes@0.1.0']);
  });

  it.each([
    ['an upload over a bundled one', ['bundled', 'uploaded'], 'shared@2.0.0'],
    ['a team extension over an upload', ['uploaded', 'team'], 'shared@2.0.0'],
    ['a team extension over a bundled one', ['bundled', 'team'], 'shared@2.0.0'],
  ] as const)('loads one copy of an id, preferring %s', async (_label, [older, newer], expected) => {
    // Arrange
    writeExtension(dirs[older], 'shared', '1.0.0');
    writeExtension(dirs[newer], 'shared', '2.0.0');
    const loader = await freshLoader();

    // Act
    await loader.loadAllExtensions();

    // Assert
    expect(registered()).toEqual([expected]);
    expect(loader.listLoadedExtensions().map((e) => `${e.id}@${e.version}`)).toEqual([expected]);
  });

  it('still loads an uploaded extension after the gateway starts again', async () => {
    // Arrange
    writeExtension(dirs.uploaded, 'notes', '0.1.0');
    await (await freshLoader()).loadAllExtensions();
    (globalThis as any).__registered = [];

    // Act
    await (await freshLoader()).loadAllExtensions();

    // Assert
    expect(registered()).toEqual(['notes@0.1.0']);
  });

  it('removes only the uploaded copy, leaving the bundled one on disk', async () => {
    // Arrange
    writeExtension(dirs.bundled, 'shared', '1.0.0');
    writeExtension(dirs.uploaded, 'shared', '2.0.0');
    const loader = await freshLoader();
    await loader.loadAllExtensions();

    // Act
    loader.removeExtension('shared');

    // Assert
    expect(fs.existsSync(path.join(dirs.uploaded, 'shared'))).toBe(false);
    expect(fs.existsSync(path.join(dirs.bundled, 'shared', 'manifest.json'))).toBe(true);
  });
});

describe('where a loaded extension lives', () => {
  it.each([
    ['only bundled', ['bundled'], 'bundled'],
    ['uploaded over bundled', ['bundled', 'uploaded'], 'uploaded'],
    ['only in the team folder', ['team'], 'team'],
  ] as const)('points at the copy that was loaded when it is %s', async (_label, where, expected) => {
    // Arrange
    for (const w of where) writeExtension(dirs[w], 'shared', w);
    const loader = await freshLoader();
    await loader.loadAllExtensions();

    // Act
    const dir = loader.extensionDir('shared');

    // Assert
    expect(dir).toBe(path.join(dirs[expected], 'shared'));
  });

  it('knows no folder for an extension that is not loaded', async () => {
    // Arrange
    const loader = await freshLoader();

    // Act
    const dir = loader.extensionDir('missing');

    // Assert
    expect(dir).toBeNull();
  });
});

describe('the gateway image', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');

  it('keeps uploads out of the folder baked into the image', () => {
    // Act
    const uploadsInImage = /^\s*ENV\s+EXT_DIR=\/app\//m.test(dockerfile);

    // Assert
    expect(uploadsInImage).toBe(false);
  });

  it('points the bundled folder at the extensions it copies in', () => {
    // Act
    const copied = /^\s*COPY\s+extensions\s+\.\/extensions\s*$/m.test(dockerfile);
    const bundled = /^\s*ENV\s+BUNDLED_EXT_DIR=\/app\/extensions\s*$/m.test(dockerfile);

    // Assert
    expect(copied).toBe(true);
    expect(bundled).toBe(true);
  });
});
