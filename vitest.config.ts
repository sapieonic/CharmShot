import { defineConfig } from 'vitest/config';

/**
 * Unit test configuration. Unit tests have NO external dependencies (no real
 * MongoDB, AWS, or Firebase) — boundaries are mocked. They run everywhere,
 * including CI, fast and deterministically.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage/unit',
      include: ['src/**/*.ts'],
      exclude: ['src/server/index.ts', 'src/**/index.ts', 'src/worker/processor.ts'],
    },
  },
});
