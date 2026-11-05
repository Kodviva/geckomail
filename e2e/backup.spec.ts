// Yedekleme ve geri yükleme uçtan uca (web, yönetici): yedek indirilir, sonradan eklenen veri geri yüklemeyle
// gider; yanlış parola uyarı verir ve aynı dosya doğru parolayla yeniden denenir; sunucu yeniden başlatılınca
// (fixture Docker gibi yeniden açar) eski oturum geçersizdir, yeniden giriş istenir.
import type { Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN, expect, seedMail, test } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import set from '../src/shared/i18n/locales/tr/set'

const T: Record<string, string> = { ...acct, ...set }
const PASS = 'yedek-parolasi-1'

async function signIn(page: Page): Promise<void> {
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
}

async function openBackup(page: Page): Promise<void> {
  await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(T['set.sec.backup'], { exact: true }).click()
}

test('yedek indirilir, geri yüklenir, yeniden başlatınca uygulanır', async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { email: 'yedek@example.test', messages: [{ subject: 'Yedekteki ileti' }] }))
  await page.goto(server.url)
  await signIn(page)
  await openBackup(page)

  await page.getByLabel(T['set.backup.web.pass'], { exact: true }).fill(PASS)
  await page.getByLabel(T['set.backup.web.passConfirm'], { exact: true }).fill(PASS)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: T['set.backup.web.download'], exact: true }).click()
  ])
  expect(download.suggestedFilename()).toMatch(/^geckomail-\d{4}-\d{2}-\d{2}\.geckobak$/)
  const file = await download.path()

  // yedekten sonra eklenen: geri yüklemeyle gitmeli
  server.withDb((db) => seedMail(db, { email: 'sonra@example.test', messages: [{ subject: 'Sonradan eklenen' }] }))

  await page.getByLabel(T['set.backup.web.file'], { exact: true }).setInputFiles(file)
  await page.getByLabel(T['set.backup.restorePass'], { exact: true }).fill('yanlis-parola-9')
  await page.getByRole('button', { name: T['set.backup.web.verify'], exact: true }).click()
  await expect(page.locator('.toast', { hasText: T['set.backup.web.err.badPassphrase'] })).toBeVisible()

  await page.getByLabel(T['set.backup.restorePass'], { exact: true }).fill(PASS)
  await page.getByRole('button', { name: T['set.backup.web.verify'], exact: true }).click()
  await expect(page.getByText(T['set.backup.web.staged'].replace('{accounts}', '1'))).toBeVisible()

  await page.getByRole('button', { name: T['set.backup.web.restartNow'], exact: true }).click()
  await expect(page.locator('.restart-banner')).toHaveText(T['set.backup.web.restarting'])
  expect(await server.restartAfterExit()).toBe(0)

  // geri yüklenen DB'de eski oturum yok: giriş ekranı ve bildirim
  await expect(page.locator('.toast', { hasText: T['set.backup.web.signInAgain'] })).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.restart-banner')).toHaveCount(0)
  await signIn(page)
  await expect(page.getByText('Yedekteki ileti')).toBeVisible()
  await expect(page.getByText('Sonradan eklenen')).toHaveCount(0)
  expect(server.logs()).not.toContain(PASS)
  expect(server.logs()).not.toContain('yanlis-parola-9')
})

test('bekleyen geri yükleme ayarlar yeniden açılınca görünür ve iptal edilir', async ({ page, server }) => {
  // hesapsız açılışta içe aktarma sihirbazı açılır (yeniden yüklemede ayarlar düğmesini örter)
  server.withDb((db) => seedMail(db, { messages: [{ subject: 'Bir ileti' }] }))
  await page.goto(server.url)
  await signIn(page)
  await openBackup(page)
  await page.getByLabel(T['set.backup.web.pass'], { exact: true }).fill(PASS)
  await page.getByLabel(T['set.backup.web.passConfirm'], { exact: true }).fill(PASS)
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: T['set.backup.web.download'], exact: true }).click()
  ])
  await page.getByLabel(T['set.backup.web.file'], { exact: true }).setInputFiles(await download.path())
  await page.getByLabel(T['set.backup.restorePass'], { exact: true }).fill(PASS)
  await page.getByRole('button', { name: T['set.backup.web.verify'], exact: true }).click()
  await expect(page.getByRole('button', { name: T['set.backup.web.cancel'], exact: true })).toBeVisible()

  // sayfa yenilenince durum sunucudan okunur
  await page.reload()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
  await openBackup(page)
  await expect(page.getByText(T['set.backup.web.pendingStaged'].split(' (')[0])).toBeVisible()
  await page.getByRole('button', { name: T['set.backup.web.cancel'], exact: true }).click()
  await expect(page.locator('.toast', { hasText: T['set.backup.web.cancelled'] })).toBeVisible()
  await expect(page.getByLabel(T['set.backup.web.file'], { exact: true })).toBeVisible()
  expect(existsSync(join(server.dataDir, 'restore-pending.db'))).toBe(false)
})
