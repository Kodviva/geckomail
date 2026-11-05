import { configDefaults, defineConfig } from 'vitest/config'

// Birim testleri; e2e/ Playwright'a ait (npm run test:e2e), vitest onları toplamaz
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**']
  }
})
