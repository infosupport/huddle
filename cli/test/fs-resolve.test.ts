import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fsResolve, toHuddlePath } from '../src/pipe/fs-list';

let tmp: string;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-resolve-'))); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('fs.resolve', () => {
  it('follows links and answers null for what does not exist', async () => {
    const real = path.join(tmp, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(tmp, 'link'), 'dir');

    const { paths } = await fsResolve({ paths: [path.join(tmp, 'link'), real, path.join(tmp, 'gone')] });

    expect(paths).toEqual([toHuddlePath(real), toHuddlePath(real), null]);
  });

  it('refuses anything but a short list of absolute paths', async () => {
    await expect(fsResolve({ paths: 'x' })).rejects.toThrow(/array/);
    await expect(fsResolve({ paths: ['relative'] })).rejects.toThrow(/absolute/);
    await expect(fsResolve({ paths: ['/a\0b'] })).rejects.toThrow(/absolute/);
    await expect(fsResolve({ paths: Array(65).fill('/') })).rejects.toThrow(/at most/);
  });
});
