import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node', // zk/ must be DOM-free; this enforces it
    include: ['src/**/__tests__/**/*.test.ts'],
  },
});
