import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests live co-located with source in src/**/*.test.ts.
    // The top-level test/ directory is for fixtures only — do not place .test.ts files there.
    // TODO(phase-1): remove --passWithNoTests from the `test` script in package.json
    // once src/services/security-headers.test.ts lands and provides real coverage.
    include: ['src/**/*.test.ts'],
    environment: 'node',
    globals: false,
    reporters: ['default'],
  },
});
