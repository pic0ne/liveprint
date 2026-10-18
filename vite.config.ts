import { defineConfig } from 'vitest/config';
import { serviceWorker } from './build/serviceWorker.ts';

export default defineConfig({
  base: './',
  plugins: [serviceWorker()],
  worker: { format: 'es' },
  test: { include: ['src/**/*.test.ts', 'test/**/*.test.ts'], testTimeout: 60_000 },
});
