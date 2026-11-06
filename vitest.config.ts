import { configDefaults, defineConfig } from 'vitest/config'

// Sunucu yalnız Linux konteynerinde çalışır: dosya kipi, sinyal ve POSIX yol varsayan testler Windows'ta koşmaz
const yalnizPosix = process.platform === 'win32' ? ['src/server/__tests__/{attachments,backupRoutes,boot,cli,http,keyfile}.test.ts'] : []

// Birim testleri; e2e/ Playwright'a ait (npm run test:e2e), vitest onları toplamaz
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**', ...yalnizPosix],
    setupFiles: ['src/test/windowsTemizlik.ts'],
    testTimeout: process.platform === 'win32' ? 90_000 : 5_000 // gerçek göç zinciri Windows CI'da yavaş
  }
})
