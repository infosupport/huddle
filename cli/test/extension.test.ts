import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { collectExtensionFiles, planInstall, isExtensionId, runExtensionRemove, MAX_FOLDER_DEPTH, insideFolder, asExtensionList } from '../src/extension';

let dir: string;

function write(rel: string, content: string): void {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-cli-ext-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('collectExtensionFiles', () => {
  it('collects every file under the folder with forward-slash names, skipping dotfiles and node_modules', () => {
    // Arrange
    write('manifest.json', JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0' }));
    write('index.js', 'module.exports.register = () => {};');
    write('frontend/component.js', '');
    write('.DS_Store', '');
    write('node_modules/x/index.js', '');

    // Act
    const { manifest, entries } = collectExtensionFiles(dir);

    // Assert
    expect(manifest).toEqual({ id: 'demo', name: 'Demo', version: '1.0.0' });
    expect(entries.map((e) => e.name).sort()).toEqual(['frontend/component.js', 'index.js', 'manifest.json']);
  });

  it.each([
    ['manifest.json', { 'index.js': '' }],
    ['index.js', { 'manifest.json': JSON.stringify({ id: 'demo', name: 'Demo' }) }],
  ])('refuses a folder without %s', (missing, files) => {
    // Arrange
    for (const [rel, content] of Object.entries(files)) write(rel, content);

    // Act
    const collect = () => collectExtensionFiles(dir);

    // Assert
    expect(collect).toThrow(new RegExp(`${missing} missing`));
  });

  it('refuses a manifest id the gateway would reject', () => {
    // Arrange
    write('manifest.json', JSON.stringify({ id: 'Bad_Id', name: 'Demo' }));
    write('index.js', '');

    // Act
    const collect = () => collectExtensionFiles(dir);

    // Assert
    expect(collect).toThrow(/manifest id/);
  });
});

describe('planInstall', () => {
  const incoming = { id: 'agent-logs', name: 'Agent logs', version: '0.2.0' };

  it('installs when no extension has that id', () => {
    // Act
    const plan = planInstall(incoming, [{ id: 'aikido', name: 'Aikido Security', version: '1.0.0' }], false);

    // Assert
    expect(plan).toEqual({ action: 'install' });
  });

  it('updates when the same extension is already installed', () => {
    // Act
    const plan = planInstall(incoming, [{ id: 'agent-logs', name: 'Agent logs', version: '0.1.0' }], false);

    // Assert
    expect(plan).toEqual({ action: 'update', from: '0.1.0' });
  });

  it('refuses when a different extension owns the id', () => {
    // Act
    const plan = planInstall(incoming, [{ id: 'agent-logs', name: 'Someone else', version: '9.0.0' }], false);

    // Assert
    expect(plan.action).toBe('refuse');
    expect(plan).toHaveProperty('reason', expect.stringMatching(/Someone else/));
  });

  it('replaces a different extension with that id only when forced', () => {
    // Act
    const plan = planInstall(incoming, [{ id: 'agent-logs', name: 'Someone else', version: '9.0.0' }], true);

    // Assert
    expect(plan).toEqual({ action: 'update', from: '9.0.0' });
  });
});

describe('collecting an extension folder safely', () => {
  const valid = () => {
    write('manifest.json', JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0' }));
    write('index.js', 'module.exports.register = () => {};');
  };

  it.each(['manifest.json', 'index.js'])('refuses a %s that is a symlink', (name) => {
    // Arrange
    valid();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-cli-outside-'));
    fs.writeFileSync(path.join(outside, 'secret'), 'not for the zip');
    fs.rmSync(path.join(dir, name));
    fs.symlinkSync(path.join(outside, 'secret'), path.join(dir, name));

    // Act
    const run = () => collectExtensionFiles(dir);

    // Assert
    expect(run).toThrow(/symlink/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a symlink anywhere in the folder instead of leaving it out of the zip', () => {
    // Arrange
    valid();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-cli-outside-'));
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.symlinkSync(outside, path.join(dir, 'lib', 'linked'));

    // Act
    const run = () => collectExtensionFiles(dir);

    // Assert
    expect(run).toThrow(/lib\/linked.*symlink/);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('refuses a folder nested deeper than the limit', () => {
    // Arrange
    valid();
    const deep = Array.from({ length: MAX_FOLDER_DEPTH + 1 }, (_, i) => `d${i}`).join('/');
    write(`${deep}/file.js`, '');

    // Act
    const run = () => collectExtensionFiles(dir);

    // Assert
    expect(run).toThrow(/nested deeper than/);
  });

  it.each([
    ['agent-logs', true], ['a1', true], ['Agent', false], ['../x', false], ['a/b', false], ['', false],
  ])('accepts %j as an extension id: %s', (id, ok) => {
    // Act
    const result = isExtensionId(id);

    // Assert
    expect(result).toBe(ok);
  });

  it.each([
    ['a parent path', '../outside.js'],
    ['a parent path further down', 'lib/../../outside.js'],
    ['an absolute path', '/etc/passwd'],
  ])('refuses to resolve %s outside the extension folder', (_label, rel) => {
    // Act
    const run = () => insideFolder(dir, rel);

    // Assert
    expect(run).toThrow(/outside the extension folder/);
  });

  it('resolves a path inside the extension folder', () => {
    // Act
    const abs = insideFolder(dir, 'lib/index.js');

    // Assert
    expect(abs).toBe(path.join(path.resolve(dir), 'lib', 'index.js'));
  });

  it('refuses to remove an invalid id before calling the gateway', async () => {
    // Act
    const run = runExtensionRemove('../x');

    // Assert
    await expect(run).rejects.toThrow(/invalid extension id/);
  });
});


describe('asExtensionList', () => {
  it('passes a list of extensions through', () => {
    // Act
    const list = asExtensionList([{ id: 'agent-logs', name: 'Agent logs' }]);

    // Assert
    expect(list).toEqual([{ id: 'agent-logs', name: 'Agent logs' }]);
  });

  it.each([[{ error: 'not found' }], ['<html>'], [null]])('refuses %j, the answer of something that is not Huddle, with a hint at HUDDLE_URL', (answer) => {
    // Act
    const act = () => asExtensionList(answer);

    // Assert
    expect(act).toThrow(/could not reach Huddle.*HUDDLE_URL/);
  });
});
