import { defineConfig } from 'vitest/config';

/**
 * Vitest config for unit tests of pure modules (analyzer, shared helpers).
 *
 * @remarks Kept separate from `vite.config.mts`, whose root points at the
 * webview sources.
 */
export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Run inside VS Code by `npm run test:integration` instead.
    exclude: ['src/test/integration/**', 'node_modules/**'],
    environment: 'node',
  },
});
