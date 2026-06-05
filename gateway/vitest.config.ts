import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Tests that touch the SQLite layer use an in-memory DB so they never read or
    // write the real /data/huddle.db. db.ts reads DB_PATH at import time, so it
    // must be set before any module import — hence here and not in a test file.
    env: { DB_PATH: ':memory:' },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
});
