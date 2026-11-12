import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

// Dependency smoke test: better-sqlite3 is a native module, so a bad pin or a missing
// prebuilt binding breaks the gateway at startup. Unlike the other suites this one
// must NEVER skip when the binding is unusable — a failure here is exactly the signal
// a dependency update PR needs to turn red.

describe('smoke: better-sqlite3', () => {
  it('opens a file database in WAL mode, writes a row and reads it back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-smoke-sqlite-'));
    const file = path.join(dir, 'smoke.db');
    const conn = new Database(file);
    try {
      expect(conn.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
      conn.exec('CREATE TABLE smoke (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT NOT NULL)');
      const info = conn.prepare('INSERT INTO smoke (note) VALUES (?)').run('hello');
      expect(info.changes).toBe(1);
      expect(conn.prepare('SELECT note FROM smoke WHERE id = ?').get(info.lastInsertRowid)).toEqual({
        note: 'hello',
      });
    } finally {
      conn.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('initialises the real Huddle schema and writes a firewall rule', async () => {
    // DB_PATH=:memory: comes from vitest.config.ts, so this never touches /data.
    const { db, initDb } = await import('../../src/db');
    initDb();
    const info = db
      .prepare(`INSERT INTO rules (domain, container_id, status) VALUES (?, NULL, 'allow')`)
      .run('smoke.example.test');
    expect(info.changes).toBe(1);
    expect(db.prepare('SELECT status FROM rules WHERE id = ?').get(info.lastInsertRowid)).toEqual({
      status: 'allow',
    });
  });
});
