import { defineConfig } from 'vitest/config'

// Yalnız `npm run test:sieve-it`: gerçek sunucuya tek işçiyle, sırayla gider
export default defineConfig({
  test: {
    root: new URL('../..', import.meta.url).pathname,
    include: ['src/sync/__tests__/sieveServer.it.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false, shuffle: false },
    maxWorkers: 1
  }
})
