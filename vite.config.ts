import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: { format: 'es' },
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'], testTimeout: 60_000, passWithNoTests: true },
});
