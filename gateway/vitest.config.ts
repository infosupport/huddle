import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Tests that touch the SQLite layer use an in-memory DB so they never read or
    // write the real /data/huddle.db. db.ts reads DB_PATH at import time, so it
    // must be set before any module import — hence here and not in a test file.
    env: { DB_PATH: ':memory:' },
    // Most suites open the SQLite layer from beforeAll with `await
    // import('../src/db')`, which pays for the TypeScript transform AND loading
    // the native better-sqlite3 binding. That does not reliably fit in vitest's
    // 10s default on a loaded machine (a devcontainer running the whole suite in
    // parallel), and when it does not the whole file reports as failed with every
    // test skipped — a timeout that reads exactly like a real regression. The
    // work is startup cost, not something a longer budget can paper over.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
