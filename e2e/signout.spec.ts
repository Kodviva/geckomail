// Aynı tarayıcıda kullanıcı değişimi: A çıkınca (başka sekmeden de) hiçbir şeyi B'ye kalmaz. Sayfa gerçekten
// yenilenir, taslak silinir, kişiler ve kayıtlı aramalar görünmez, açık pencere kalmaz. Nedeni yenilemeden sonra söylenir.
import type { Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import compose from '../src/shared/i18n/locales/tr/compose'
import mail from '../src/shared/i18n/locales/tr/mail'
import { hashPassword } from '../src/sync/auth/password'

const CONTACT = 'gizli-kisi@example.test'
const B = { username: 'ikinci', password: 'ikinci-parola-123' }

function seed(server: GeckoServer): void {
  server.withDb((db) => {
    seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A iletisi', from: CONTACT }] })
    const { accountId } = seedMail(db, { email: 'b@example.test', messages: [{ subject: 'B iletisi', from: 'b-kisi@example.test' }] })
    // B yalnız kendi hesabının grubunu görür; yönetici değil
    const now = Date.now()
    const group = Number(db.prepare(`INSERT INTO groups (name, color, created_at) VALUES ('B', '#111111', ?)`).run(now).lastInsertRowid)
    db.prepare(`UPDATE accounts SET group_id = ? WHERE id = ?`).run(group, accountId)
    const user = Number(
      db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'member', ?)`).run(B.username, hashPassword(B.password), now).lastInsertRowid
    )
    db.prepare(`INSERT INTO user_group_permissions (user_id, group_id, can_view, can_manage) VALUES (?, ?, 1, 1)`).run(user, group)
  })
}

async function signIn(page: Page, u: { username: string; password: string }): Promise<void> {
  await page.getByLabel(acct['acct.common.username'], { exact: true }).fill(u.username)
  await page.getByLabel(acct['acct.common.password'], { exact: true }).fill(u.password)
  await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(u.username)
}

const toField = (page: Page) => page.getByPlaceholder(compose['compose.field.toPlaceholder'])

test('A çıkar, B aynı tarayıcıda girer: taslak, kişi, kayıtlı arama, açık pencere kalmaz', async ({ context, page, server }) => {
  seed(server)
  await page.goto(server.url)
  await signIn(page, ADMIN)

  // A: kayıtlı arama
  await page.getByPlaceholder(mail['mail.search.placeholder']).fill('kayitli')
  page.once('dialog', (d) => void d.accept('A araması'))
  await page.getByRole('button', { name: mail['mail.saved.save'] }).click()
  await expect(page.locator('.saved-chip')).toHaveCount(1)
  await page.getByPlaceholder(mail['mail.search.placeholder']).fill('')

  // A: açık oluşturucu, yerel taslak, otomatik tamamlamada kişi
  await page.locator('.sf-add').click()
  await toField(page).fill('gizli')
  await expect(page.locator('.addr-suggest', { hasText: CONTACT })).toBeVisible()
  await toField(page).fill(CONTACT)
  await expect.poll(() => page.evaluate(() => localStorage.getItem('gecko-draft'))).toContain(CONTACT)
  await page.evaluate(() => {
    ;(window as unknown as { __ayniSayfa: boolean }).__ayniSayfa = true
  })

  // A başka sekmeden çıkar: bu sekme 4401 alır, oluşturucu açıkken
  const other = await context.newPage()
  await other.goto(server.url)
  await other.locator('.whoami').click()
  await other.getByRole('menuitem', { name: acct['acct.panel.logout'] }).click()
  await expect(other.getByRole('button', { name: acct['acct.login.signIn'], exact: true })).toBeVisible()
  await other.close()

  await expect(page.getByRole('button', { name: acct['acct.login.signIn'], exact: true })).toBeVisible()
  // tam yenileme, neden yenilemeden sonra gösterildi
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ayniSayfa?: boolean }).__ayniSayfa)).toBeUndefined()
  await expect(page.locator('.toast', { hasText: acct['acct.session.expired'] })).toBeVisible()
  expect(await page.evaluate(() => sessionStorage.getItem('gecko-signout-reason'))).toBeNull()
  expect(await page.evaluate(() => localStorage.getItem('gecko-draft'))).toBeNull()

  await signIn(page, B)
  await expect(page.locator('.msg-row', { hasText: 'B iletisi' })).toBeVisible()
  await expect(page.locator('.msg-row', { hasText: 'A iletisi' })).toHaveCount(0)
  await expect(page.locator('.overlay')).toHaveCount(0)
  await expect(page.locator('.modal.composer')).toHaveCount(0)
  await expect(page.locator('.saved-chip')).toHaveCount(0)
  // oluşturucu boş açılır, A'nın kişisi önerilmez; B'nin kişisi önerilir (öneri listesi çalışıyor)
  await page.locator('.sf-add').click()
  await expect(toField(page)).toHaveValue('')
  await toField(page).fill('kisi')
  await expect(page.locator('.addr-suggest', { hasText: 'b-kisi@example.test' })).toBeVisible()
  await expect(page.locator('.addr-suggest', { hasText: CONTACT })).toHaveCount(0)
})

test('kendi çıkışı: sayfa yenilenir, bildirim yok, taslak silinir', async ({ page, server }) => {
  seed(server)
  await page.goto(server.url)
  await signIn(page, ADMIN)
  await page.evaluate(() => {
    localStorage.setItem('gecko-draft', JSON.stringify({ to: 'x@y.z', subject: 's', text: 't' }))
    ;(window as unknown as { __ayniSayfa: boolean }).__ayniSayfa = true
  })
  await page.locator('.whoami').click()
  await page.getByRole('menuitem', { name: acct['acct.panel.logout'] }).click()
  await expect(page.getByRole('button', { name: acct['acct.login.signIn'], exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { __ayniSayfa?: boolean }).__ayniSayfa)).toBeUndefined()
  expect(await page.evaluate(() => localStorage.getItem('gecko-draft'))).toBeNull()
  await expect(page.locator('.toast')).toHaveCount(0)
})
