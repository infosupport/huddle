import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { createZip } from '../src/zip';

describe('createZip', () => {
  it('writes a zip the gateway can read back, byte for byte', () => {
    // Arrange
    const entries = [
      { name: 'manifest.json', data: Buffer.from('{"id":"demo","name":"Demo"}') },
      { name: 'frontend/component.js', data: Buffer.from('console.log("héllo");') },
      { name: 'empty.txt', data: Buffer.alloc(0) },
    ];

    // Act
    const zip = new AdmZip(createZip(entries));

    // Assert
    expect(zip.getEntries().map((e) => e.entryName)).toEqual(entries.map((e) => e.name));
    for (const entry of entries) {
      expect(zip.getEntry(entry.name)!.getData().equals(entry.data)).toBe(true);
    }
  });

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a parent segment', 'frontend/../../evil.js'],
    ['a backslash', 'frontend\\evil.js'],
    ['an empty name', ''],
  ])('refuses an entry with %s', (_label, name) => {
    // Act
    const build = () => createZip([{ name, data: Buffer.from('x') }]);

    // Assert
    expect(build).toThrow(/invalid zip entry name/);
  });
});
