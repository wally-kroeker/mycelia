import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests use a better-sqlite3-backed D1 adapter (see
    // tests/integration/_d1-adapter.ts). Unit tests are pure-function and
    // need no special setup. Both run under the default node pool.
  },
});
