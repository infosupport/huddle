import { defineConfig } from 'vitest/config';

// Aparte config voor de LIVE end-to-end boundary-suite. Deze tests spinnen echte
// devcontainers op via de draaiende huddle-stack en exec'en erin — ze horen NIET
// in de snelle unit-run (`npm test`). Draai expliciet met `npm run test:e2e` op een
// host met Docker + een draaiende huddle (zie test/e2e/README.md).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.e2e.ts'],
    testTimeout: 180_000,   // spawn + exec + echte netwerk-round-trips
    hookTimeout: 600_000,   // beforeAll bouwt evt. eerst de base-image
    fileParallelism: false, // één container tegelijk; geen race op de stack
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    retry: 0,
  },
});
