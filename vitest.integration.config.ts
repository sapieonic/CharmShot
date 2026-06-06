import { defineConfig } from 'vitest/config';

/**
 * Integration test configuration. Integration tests exercise multiple layers
 * wired together (router → services → repositories) against a REAL MongoDB
 * reached via MONGODB_URI. Only the external SaaS boundaries (AWS, Firebase)
 * are mocked.
 *
 * When no MongoDB is reachable (e.g. a dev box without one), the suites gate
 * themselves off via tests/helpers/db.ts and skip cleanly. In CI a `mongo`
 * service container is provided, so they run for real.
 *
 * Tests run single-threaded (no file parallelism) so they can share a single
 * database without cross-test interference.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
});
