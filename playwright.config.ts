import { defineConfig, devices } from '@playwright/test'

// Uçtan uca web testleri: sunucuyu her test kendi geçici dizininde ve boş portta başlatır (e2e/fixtures.ts);
// webServer kullanılmaz. Önce derleme gerekir: npm run test:e2e (build:server + playwright test).
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  // makine başka yazılımlarla yüklü: her test kendi sunucusunu başlatır, eşzamanlılık sınırlı
  // E2E_WORKERS geçersizse (sayı değil, 0, negatif) 2
  workers: process.env.CI ? 2 : (Number.isInteger(Number(process.env.E2E_WORKERS)) && Number(process.env.E2E_WORKERS) > 0 ? Number(process.env.E2E_WORKERS) : 2),
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    locale: 'tr-TR',
    trace: 'retain-on-failure'
  },
  // üç motor: çerez/SameSite ve açılır pencere davranışı tarayıcıya göre değişir (ör. web OAuth dönüşü)
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } }
  ]
})
