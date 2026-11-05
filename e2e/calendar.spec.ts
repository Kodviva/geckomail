// Takvim uçtan uca: etkinlik oluşturma, tekrar eden bir örneği düzenleme, dar ekranda geri tuşu, abonelik hatası. Masaüstü ve 375×812.
import type { Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import calendar from '../src/shared/i18n/locales/tr/calendar'
import common from '../src/shared/i18n/locales/tr/common'
import pim from '../src/shared/i18n/locales/tr/pim'

const T: Record<string, string> = { ...acct, ...calendar, ...common, ...pim }

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.msg-row').first()).toBeVisible()
  const menu = page.locator('.nav-menu-btn').first()
  if (await menu.isVisible()) await menu.click()
  await page.locator('.app-nav').getByRole('button', { name: T['calendar.title'], exact: true }).click()
}

for (const [label, size] of [['masaüstü', { width: 1280, height: 800 }], ['telefon', { width: 375, height: 812 }]] as const) {
  test.describe(label, () => {
    test.use({ viewport: size })

    test('etkinlik oluştur, tekrar eden bir örneği düzenle, seri durur', async ({ page, server }) => {
      server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
      await open(page, server.url)
      await page.getByLabel(T['calendar.view.label'], { exact: true }).selectOption('agenda')
      await page.getByRole('button', { name: T['calendar.new'], exact: true }).click()
      await page.getByLabel(T['calendar.field.title'], { exact: true }).fill('Haftalık')
      await page.locator('.pim-form select:has(option[value="DAILY"])').selectOption('DAILY')
      await page.getByRole('button', { name: T['action.save'], exact: true }).click()
      await expect(page.locator('.pim-detail h2')).toHaveText('Haftalık')
      if (size.width < 768) {
        await page.goBack()
        await expect(page.locator('.pim-detail')).toHaveCount(0)
      }
      const rows = page.locator('.cal-agenda-row', { hasText: 'Haftalık' })
      await expect(rows.nth(1)).toBeVisible()
      const before = await rows.count()
      await rows.nth(1).click()
      await page.locator('.pim-detail').getByRole('button', { name: T['action.edit'], exact: true }).click()
      await page.getByRole('button', { name: T['calendar.scope.this'], exact: true }).click()
      await page.getByLabel(T['calendar.field.title'], { exact: true }).fill('Tek seferlik')
      await page.getByRole('button', { name: T['action.save'], exact: true }).click()
      await expect(page.locator('.pim-detail h2')).toHaveText('Tek seferlik')
      if (size.width < 768) await page.goBack()
      await expect(page.locator('.cal-agenda-row', { hasText: 'Tek seferlik' })).toHaveCount(1)
      await expect(rows).toHaveCount(before - 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })

    test('abonelik ekleme hatası görünür, kaynak açılmaz', async ({ page, server }) => {
      server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
      await open(page, server.url)
      if (size.width < 1024) await page.getByRole('button', { name: T['calendar.list'], exact: true }).click()
      await page.getByRole('button', { name: T['calendar.sub.add'], exact: true }).click()
      await page.getByLabel(T['calendar.sub.url'], { exact: true }).fill('http://127.0.0.1:9/ic-ag.ics')
      await page.locator('form').filter({ has: page.getByLabel(T['calendar.sub.url'], { exact: true }) }).locator('button[type=submit]').click()
      await expect(page.locator('.toast')).toBeVisible()
      expect(server.withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM pim_sources WHERE kind = 'ics'`).get())).toEqual({ n: 0 })
    })
  })
}
