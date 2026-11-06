import { describe, it, expect, beforeAll } from 'vitest';

// Trusted image IDs (DB_PATH=':memory:' from vitest.config.ts): only images
// Huddle recorded itself may skip the Huddle layer.

let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[trusted-images.test] SKIPPED — better-sqlite3 not usable: ${(e as Error).message}`);
}

let dbMod: typeof import('../src/db');

beforeAll(async () => {
  if (!sqliteAvailable) return;
  dbMod = await import('../src/db');
  dbMod.initDb();
});

describe.skipIf(!sqliteAvailable)('trusted images', () => {
  it('knows nothing about an image it did not record', () => {
    // Act
    const trusted = dbMod.getTrustedImage('sha256:' + 'f'.repeat(64));

    // Assert
    expect(trusted).toBeNull();
  });

  it('remembers a snapshot and a derived image with its layer version', () => {
    // Arrange
    dbMod.recordTrustedImage('sha256:' + 'a'.repeat(64), { kind: 'snapshot' });
    dbMod.recordTrustedImage('sha256:' + 'b'.repeat(64), { kind: 'derived', layerVersion: '2' });

    // Act
    const snapshot = dbMod.getTrustedImage('sha256:' + 'a'.repeat(64));
    const derived = dbMod.getTrustedImage('sha256:' + 'b'.repeat(64));

    // Assert
    expect(snapshot).toEqual({ kind: 'snapshot' });
    expect(derived).toEqual({ kind: 'derived', layerVersion: '2' });
  });

  it('matches an ID with or without the sha256: prefix (Docker vs Podman)', () => {
    // Arrange
    dbMod.recordTrustedImage('c'.repeat(64), { kind: 'snapshot' });

    // Act
    const trusted = dbMod.getTrustedImage('sha256:' + 'c'.repeat(64));

    // Assert
    expect(trusted).toEqual({ kind: 'snapshot' });
  });
});
