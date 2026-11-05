// Kişi ve takvim kabuğu: Ayarlar › Kişiler ve Takvim, hesap penceresindeki bağlama düğmesi, üst görünüm geçişi ve yerel defter.
import type { Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import common from '../src/shared/i18n/locales/tr/common'
import calendar from '../src/shared/i18n/locales/tr/calendar'
import contacts from '../src/shared/i18n/locales/tr/contacts'
import pim from '../src/shared/i18n/locales/tr/pim'

const T: Record<string, string> = { ...acct, ...calendar, ...common, ...contacts, ...pim }

async function signIn(page: Page, url: string, user = ADMIN): Promise<void> {
  await page.goto(url)
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(user.username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(user.password)
  await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(user.username)
}

function seedSource(server: GeckoServer, accountId: number, status: string, error: string | null): number {
  return server.withDb((db) => Number(db.prepare(
    `INSERT INTO pim_sources (kind, account_id, label, auth, status, last_error, next_sync_at, created_at) VALUES ('dav', ?, 'a@example.test', 'account', ?, ?, 9999999999999, 1)`
  ).run(accountId, status, error).lastInsertRowid))
}

async function openAccount(page: Page): Promise<void> {
  await page.locator('.acct-row', { hasText: 'Deneme' }).first().click({ button: 'right' })
  await page.locator('.ctx-item', { hasText: T['acct.menu.editAccount'] }).click()
}

test('ayarlar: kaynak listesi durum gösterir, kaldırılır; kişisel DAV formu hata söyler', async ({ page, server }) => {
  const { accountId } = server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
  const id = seedSource(server, accountId, 'needs_reauth', 'reddedildi')
  await signIn(page, server.url)
  await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(T['pim.set.title'], { exact: true }).click()
  const list = page.getByTestId('pim-sources')
  await expect(list).toContainText(T['pim.set.statusReauth'])
  await expect(list).toContainText('reddedildi')
  await expect(list.getByRole('button', { name: T['pim.set.syncNow'], exact: true })).toHaveCount(0) // reddedilmiş kimlik kullanıcı eylemiyle de denenmez
  await list.getByRole('button', { name: T['action.remove'], exact: true }).click()
  await expect(list).toContainText(T['pim.set.empty'])
  expect(server.withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM pim_sources WHERE id = ?`).get(id))).toEqual({ n: 0 })

  await list.getByRole('button', { name: T['action.add'], exact: true }).click()
  await list.getByLabel(T['pim.set.url'], { exact: true }).fill('https://dav.example.invalid/')
  await list.getByLabel(T['pim.set.username'], { exact: true }).fill('kisi')
  await list.getByLabel(T['pim.set.password'], { exact: true }).fill('parola')
  await list.locator('form').getByRole('button', { name: T['action.add'], exact: true }).click()
  await expect(page.locator('.toast')).toBeVisible()
  // sunucuda parola saklanmadı, kaynak açılmadı
  expect(server.withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM pim_sources WHERE kind = 'dav'`).get())).toEqual({ n: 0 })
})

test('hesap penceresi: yöneten bağlama düğmesini görür, sunucu yoksa söyler', async ({ page, server }) => {
  const { accountId } = server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
  await signIn(page, server.url)
  await openAccount(page)
  await expect(page.getByText(T['pim.acct.hint'], { exact: true })).toBeVisible()
  await page.getByRole('button', { name: T['pim.acct.connect'], exact: true }).click()
  // örnek hesabın parolası çözülemez: sonuç toast'ta görünür, kaynak açılmaz
  await expect(page.locator('.toast', { hasText: T['pim.connect.noSecret'] })).toBeVisible()

  seedSource(server, accountId, 'ok', null)
  await page.reload()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
  await openAccount(page)
  await expect(page.getByText(T['pim.acct.linked'], { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: T['pim.acct.connect'], exact: true })).toHaveCount(0)
})

test('hesap penceresi: yalnız gören üyeye bağlama düğmesi gösterilmez', async ({ page, server }) => {
  const user = { username: 'uye', password: 'uye-parola-12345' }
  await server.createUser(user.username, user.password)
  server.withDb((db) => {
    const { accountId } = seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] })
    const group = Number(db.prepare(`INSERT INTO groups (name, color, created_at) VALUES ('A', '#111111', 1)`).run().lastInsertRowid)
    db.prepare(`UPDATE accounts SET group_id = ? WHERE id = ?`).run(group, accountId)
    const { id } = db.prepare(`UPDATE users SET role = 'member' WHERE username = ? RETURNING id`).get(user.username) as { id: number }
    db.prepare(`INSERT INTO user_group_permissions (user_id, group_id, can_view, can_manage) VALUES (?, ?, 1, 0)`).run(id, group)
  })
  await signIn(page, server.url, user)
  await openAccount(page)
  await expect(page.locator('.modal')).toBeVisible()
  await expect(page.getByRole('button', { name: T['pim.acct.connect'], exact: true })).toHaveCount(0)
})

test('kişiler: yerel deftere kart eklenir, posta seçimi korunur, dar ekranda geri tuşu listeye döner', async ({ page, server }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const { accountId } = server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
  expect(accountId).toBeGreaterThan(0)
  await signIn(page, server.url)
  await page.locator('.nav-menu-btn').first().click()
  await page.locator('.app-nav').getByRole('button', { name: T['contacts.title'], exact: true }).click()
  await page.getByRole('button', { name: T['contacts.new'], exact: true }).click()
  await page.getByLabel(T['contacts.field.fullName'], { exact: true }).fill('Ayşe Kaya')
  await page.getByRole('textbox', { name: T['contacts.field.email'], exact: true }).fill('ayse@example.test')
  await page.getByRole('button', { name: T['action.save'], exact: true }).click()
  await expect(page.locator('.pim-detail h2')).toHaveText('Ayşe Kaya')
  await expect(page.locator('.pim-listpane')).toHaveCount(0)
  await page.goBack()
  await expect(page.locator('.pim-listpane .contact-row', { hasText: 'Ayşe Kaya' })).toBeVisible()
  await page.goBack()
  await expect(page.locator('.msg-row', { hasText: 'A' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('takvim: yerel takvimde etkinlik oluşur, görünümler arasında görünür, silinir', async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
  await signIn(page, server.url)
  await page.locator('.app-nav').getByRole('button', { name: T['calendar.title'], exact: true }).click()
  await page.getByRole('button', { name: T['calendar.new'], exact: true }).click()
  await page.getByLabel(T['calendar.field.title'], { exact: true }).fill('Kahve molası')
  await page.getByRole('button', { name: T['action.save'], exact: true }).click()
  await expect(page.locator('.pim-detail h2')).toHaveText('Kahve molası')
  await expect(page.locator('.cal-month .cal-chip', { hasText: 'Kahve molası' })).toBeVisible()
  await page.getByLabel(T['calendar.view.label'], { exact: true }).selectOption('week')
  await expect(page.locator('.cal-block', { hasText: 'Kahve molası' })).toBeVisible()
  await page.getByLabel(T['calendar.view.label'], { exact: true }).selectOption('agenda')
  await expect(page.locator('.cal-agenda-row', { hasText: 'Kahve molası' })).toBeVisible()
  page.once('dialog', (d) => void d.accept())
  await page.locator('.pim-detail').getByRole('button', { name: T['action.delete'], exact: true }).click()
  await expect(page.locator('.cal-agenda-row')).toHaveCount(0)
})

test('takvim dar ekran: ajanda varsayılan, hafta seçeneği yok, ayrıntıdan geri tuşu takvime döner; abonelik hatası görünür', async ({ page, server }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
  await signIn(page, server.url)
  await page.locator('.nav-menu-btn').first().click()
  await page.locator('.app-nav').getByRole('button', { name: T['calendar.title'], exact: true }).click()
  const view = page.getByLabel(T['calendar.view.label'], { exact: true })
  await expect(view).toHaveValue('agenda')
  await expect(view.locator('option[value="week"]')).toHaveCount(0)
  await page.getByRole('button', { name: T['calendar.new'], exact: true }).click()
  await page.getByLabel(T['calendar.field.title'], { exact: true }).fill('Dar etkinlik')
  await page.getByRole('button', { name: T['action.save'], exact: true }).click()
  await expect(page.locator('.pim-detail h2')).toHaveText('Dar etkinlik')
  await expect(page.locator('.cal-head')).toHaveCount(0)
  await page.goBack()
  await expect(page.locator('.cal-agenda-row', { hasText: 'Dar etkinlik' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await page.getByRole('button', { name: T['calendar.list'], exact: true }).click()
  await page.getByRole('button', { name: T['calendar.sub.add'], exact: true }).click()
  await page.getByLabel(T['calendar.sub.url'], { exact: true }).fill('http://127.0.0.1/ic.ics')
  await page.getByRole('button', { name: T['action.add'], exact: true }).click()
  await expect(page.locator('.toast')).toBeVisible()
  expect(server.withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM pim_sources WHERE kind = 'ics'`).get())).toEqual({ n: 0 })
})
