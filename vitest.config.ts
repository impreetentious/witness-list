import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'src') },
  },
  test: {
    environment: 'node', // zk/ must be DOM-free; this enforces it
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
