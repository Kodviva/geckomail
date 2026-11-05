// Çevrimdışı okuma uçtan uca: mod ayarlardan açılır, ileti ve gövde şifreli saklanır; ağ kesilince uygulama
// önbellekten açılır, kopya salt okunur gösterilir. Çıkış ve geçersiz oturum kopyayı ve kabuk önbelleğini siler.
import type { BrowserContext, Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import calendar from '../src/shared/i18n/locales/tr/calendar'
import common from '../src/shared/i18n/locales/tr/common'
import contacts from '../src/shared/i18n/locales/tr/contacts'
import set from '../src/shared/i18n/locales/tr/set'

const SUBJECT = 'Gizli çevrimdışı konu'
const HTML_TEXT = 'Şifreli gövde metni'

async function signIn(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.getByLabel(acct['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(acct['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
}

function seed(server: GeckoServer): void {
  server.withDb((db) => {
    const { messageIds } = seedMail(db, { messages: [{ subject: SUBJECT, preview: 'gizli önizleme' }, { subject: 'İkinci ileti', seen: true }] })
    const ins = db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, ?, ?, ?, ?, 100)`)
    const now = Date.now()
    ins.run(messageIds[0], HTML_TEXT, `<p>${HTML_TEXT}</p><img src="https://uzak.example.test/iz.png">`, now, now)
    ins.run(messageIds[1], 'Düz metin gövde', null, now, now)
  })
}

async function enableOffline(page: Page): Promise<void> {
  await page.getByRole('button', { name: acct['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(set['set.sec.general'], { exact: true }).click()
  await page.getByLabel(set['set.offline.toggle'], { exact: true }).check()
  await expect(page.getByText(/^2 ileti saklı/)).toBeVisible()
  await expect.poll(() => shellCaches(page)).toHaveLength(1)
  await page.keyboard.press('Escape')
}

/** setOffline HTTP'yi keser ama WebKit'te WebSocket'i kesmez: sunucu da durdurulur. Önce sunucu: Chromium'un ağ
 *  öykünmesi açıkken soketin kapanışı sayfaya ulaşmayabilir */
async function goOffline(context: BrowserContext, server: GeckoServer): Promise<void> {
  await server.stop()
  await context.setOffline(true)
}

async function backOnline(context: BrowserContext, server: GeckoServer): Promise<void> {
  await server.restartAfterExit()
  await context.setOffline(false)
}

const shellCaches = (page: Page): Promise<string[]> =>
  page.evaluate(async () => (await caches.keys()).filter((n) => n.startsWith('gecko-shell-')))

const hasDb = (page: Page): Promise<boolean> =>
  page.evaluate(async () => (await indexedDB.databases()).some((d) => d.name === 'gecko-offline'))

/** Ham kayıtlar: her alan JSON'a; ArrayBuffer baytları metin olarak (düz metin kalsaydı aramada çıkardı) */
const rawDump = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open('gecko-offline')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const out: unknown[] = []
    for (const name of Array.from(db.objectStoreNames)) {
      const all = await new Promise<unknown[]>((res) => {
        const q = db.transaction(name).objectStore(name).getAll()
        q.onsuccess = () => res(q.result)
      })
      out.push(all.map((r) => (r instanceof CryptoKey ? 'anahtar' : r)))
    }
    db.close()
    const text = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (c) => String.fromCharCode(c)).join('')
    return JSON.stringify(out, (_k, v: unknown) => (v instanceof ArrayBuffer ? text(v) : v))
  })

test('çevrimdışı açılış: liste ve ileti kopyadan, yazma kapalı, kopya şifreli; bağlantı gelince normale döner', async ({ page, server, context }) => {
  seed(server)
  await signIn(page, server.url)
  await expect(page.getByText(SUBJECT)).toBeVisible()
  await enableOffline(page)

  const dump = await rawDump(page)
  expect(dump.length).toBeGreaterThan(200)
  for (const s of [SUBJECT, 'gizli önizleme', HTML_TEXT, 'deneme@example.test', 'subject']) expect(dump).not.toContain(s)

  const remote: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('uzak.example.test')) remote.push(r.url())
  })

  await goOffline(context, server)
  await page.reload()
  await expect(page.locator('.list-offline')).toHaveText(common['common.offlineBanner'])
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
  await expect(page.getByRole('button', { name: acct['acct.login.signIn'], exact: true })).toHaveCount(0)

  await page.getByText(SUBJECT).click()
  await expect(page.frameLocator('iframe.mail-frame').getByText(HTML_TEXT)).toBeVisible()
  await page.getByText('İkinci ileti').click()
  await expect(page.locator('.mail-plain')).toHaveText('Düz metin gövde')

  // yazma eylemleri kapalı ve açıklamalı
  const del = page.locator('.view-toolbar').getByRole('button', { name: 'Sil', exact: true })
  await expect(del).toBeDisabled()
  await expect(del).toHaveAttribute('title', common['common.offlineReadOnly'])
  await expect(page.locator('.sf-add')).toBeDisabled()
  // kısayol da salt okunur: yazma penceresi açılmaz, açıklama çıkar
  await page.keyboard.press('n')
  await expect(page.getByText(common['common.offlineReadOnly']).first()).toBeVisible()
  expect(await page.locator('.composer').count()).toBe(0)
  expect(remote).toEqual([])

  await backOnline(context, server)
  await expect(page.locator('.list-offline')).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('.sf-add')).toBeEnabled()
  await expect(page.getByText(SUBJECT)).toBeVisible()
})

test('takvim ve kişiler kopyadan salt okunur, kopya şifreli; saklı olmayan ay açıklanır', async ({ page, server, context }) => {
  seed(server)
  await signIn(page, server.url)
  await page.locator('.app-nav').getByRole('button', { name: calendar['calendar.title'], exact: true }).click()
  await page.getByRole('button', { name: calendar['calendar.new'], exact: true }).click()
  await page.getByLabel(calendar['calendar.field.title'], { exact: true }).fill('Şifreli toplantı')
  await page.getByRole('button', { name: common['action.save'], exact: true }).click()
  await expect(page.locator('.cal-month .cal-chip', { hasText: 'Şifreli toplantı' })).toBeVisible()
  await page.locator('.app-nav').getByRole('button', { name: contacts['contacts.title'], exact: true }).click()
  await page.getByRole('button', { name: contacts['contacts.new'], exact: true }).click()
  await page.getByLabel(contacts['contacts.field.fullName'], { exact: true }).fill('Saklı Kişi')
  await page.getByRole('button', { name: common['action.save'], exact: true }).click()
  await expect(page.locator('.pim-detail h2')).toHaveText('Saklı Kişi')
  await enableOffline(page)
  await expect.poll(async () => (await rawDump(page)).length).toBeGreaterThan(0)
  await expect.poll(async () => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res) => { const r = indexedDB.open('gecko-offline'); r.onsuccess = () => res(r.result) })
    const keys = await new Promise<IDBValidKey[]>((res) => { const q = db.transaction('meta').objectStore('meta').getAllKeys(); q.onsuccess = () => res(q.result) })
    db.close()
    return keys.filter((k) => String(k).startsWith('pim:events:')).length
  })).toBe(8)
  const raw = await rawDump(page)
  expect(raw).not.toContain('Şifreli toplantı')
  expect(raw).not.toContain('Saklı Kişi')
  await goOffline(context, server)
  await page.reload()
  await expect(page.locator('.list-offline')).toHaveText(common['common.offlineBanner'])
  await page.locator('.app-nav').getByRole('button', { name: calendar['calendar.title'], exact: true }).click()
  await expect(page.locator('.cal-month .cal-chip', { hasText: 'Şifreli toplantı' })).toBeVisible()
  await expect(page.getByRole('button', { name: calendar['calendar.new'], exact: true })).toBeDisabled()
  await page.locator('.app-nav').getByRole('button', { name: contacts['contacts.title'], exact: true }).click()
  await expect(page.locator('.contact-row', { hasText: 'Saklı Kişi' })).toBeVisible()
  await page.locator('.app-nav').getByRole('button', { name: calendar['calendar.title'], exact: true }).click()
  for (let i = 0; i < 9; i++) await page.getByRole('button', { name: calendar['calendar.next'], exact: true }).click()
  await expect(page.getByText(calendar['calendar.offlineEmpty'], { exact: true })).toBeVisible()
  await backOnline(context, server)
})

test('oturum açıkken bağlantı kopunca kopyaya geçilir', async ({ page, server, context }) => {
  seed(server)
  await signIn(page, server.url)
  await enableOffline(page)
  await goOffline(context, server)
  await expect(page.locator('.list-offline')).toBeVisible({ timeout: 30_000 })
  await page.getByText(SUBJECT).click()
  await expect(page.frameLocator('iframe.mail-frame').getByText(HTML_TEXT)).toBeVisible()
})

test('çıkış kopyayı ve kabuk önbelleğini siler', async ({ page, server }) => {
  seed(server)
  await signIn(page, server.url)
  await enableOffline(page)
  expect(await hasDb(page)).toBe(true)

  await page.locator('.whoami').click()
  await page.getByRole('menuitem', { name: acct['acct.panel.logout'] }).click()
  await expect(page.getByRole('button', { name: acct['acct.login.signIn'], exact: true })).toBeVisible()
  await expect.poll(() => hasDb(page)).toBe(false)
  await expect.poll(() => shellCaches(page)).toEqual([])
})

test('çevrimdışıyken çıkış: kopya hemen silinir, oturum bağlantı gelince sunucuda kapanır', async ({ page, server, context }) => {
  seed(server)
  await signIn(page, server.url)
  await enableOffline(page)
  await goOffline(context, server)
  await page.reload()
  await expect(page.locator('.list-offline')).toBeVisible()

  await page.locator('.whoami').click()
  await page.getByRole('menuitem', { name: acct['acct.panel.logout'] }).click()
  await expect(page.getByRole('button', { name: acct['acct.login.signIn'], exact: true })).toBeVisible()
  await expect.poll(() => hasDb(page)).toBe(false)

  await backOnline(context, server)
  await page.reload()
  await expect(page.getByRole('button', { name: acct['acct.login.signIn'], exact: true })).toBeVisible()
  await expect(page.locator('.whoami-name')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('gecko-offline-logout'))).toBeNull()
})

test('kopya varken oturum sunucuda düştüyse bağlantı gelince silinir, giriş sorulur', async ({ page, server, context }) => {
  seed(server)
  await signIn(page, server.url)
  await enableOffline(page)
  await goOffline(context, server)
  await page.reload()
  await expect(page.locator('.list-offline')).toBeVisible()

  server.withDb((db) => db.prepare(`DELETE FROM web_sessions`).run())
  await backOnline(context, server)
  await expect(page.getByRole('button', { name: acct['acct.login.signIn'], exact: true })).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => hasDb(page)).toBe(false)
  await expect.poll(() => shellCaches(page)).toEqual([])
})

test('çevrimdışı çıkış diğer sekmeyi de hemen çıkarır', async ({ page, server, context }) => {
  seed(server)
  await signIn(page, server.url)
  await enableOffline(page)
  const other = await context.newPage()
  await other.goto(server.url)
  await expect(other.getByText(SUBJECT)).toBeVisible() // liste RPC ile gelir: soket açık
  await goOffline(context, server)
  await expect(other.locator('.list-offline')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('.list-offline')).toBeVisible({ timeout: 30_000 })

  await page.locator('.whoami').click()
  await page.getByRole('menuitem', { name: acct['acct.panel.logout'] }).click()
  await expect(other.getByRole('button', { name: acct['acct.login.signIn'], exact: true })).toBeVisible()
  await expect(other.getByText(SUBJECT)).toHaveCount(0)
})

test('sekmede açılan simge kabuğu ezmez', async ({ page, server, context }) => {
  seed(server)
  await signIn(page, server.url)
  await enableOffline(page)
  await page.goto(`${server.url}/icons/icon-192.png`)
  await page.goto(server.url)
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
  await goOffline(context, server)
  await page.reload()
  await expect(page.locator('.list-offline')).toBeVisible()
})

const OTHER = { username: 'ikinci', password: 'ikinci-parola-1' }

/** Sayfa içinden: çerez tarayıcıda değişir, sayfanın istemcisi önceki kullanıcıda kalır (başka sekmede giriş gibi) */
const loginInBackground = (page: Page): Promise<void> =>
  page.evaluate(async (u) => {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(u) })
    if (!r.ok) throw new Error(`giriş ${r.status}`)
  }, OTHER)

test('başka kullanıcı girince kopya silinir, ayar onun için kapalıdır', async ({ page, server }) => {
  seed(server)
  await server.createUser(OTHER.username, OTHER.password)
  await signIn(page, server.url)
  await enableOffline(page)
  await loginInBackground(page)
  await page.reload()
  await expect(page.locator('.whoami-name')).toHaveText(OTHER.username)
  await expect.poll(() => hasDb(page)).toBe(false)
  await expect.poll(() => shellCaches(page)).toEqual([])
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('gecko-offline'))) ?? '{}')).toMatchObject({ on: false, userId: null })
  await page.getByRole('button', { name: acct['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(set['set.sec.general'], { exact: true }).click()
  await expect(page.getByLabel(set['set.offline.toggle'], { exact: true })).not.toBeChecked()
})

test('kopyayla açılış: çerez başka kullanıcınınsa bağlantı gelince kopya silinir, önceki kullanıcı ekranda kalmaz', async ({ page, server, context }) => {
  seed(server)
  await server.createUser(OTHER.username, OTHER.password)
  await signIn(page, server.url)
  await enableOffline(page)
  await loginInBackground(page)
  await goOffline(context, server)
  await page.reload()
  await expect(page.locator('.list-offline')).toBeVisible()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username) // kopya sahibi

  await backOnline(context, server)
  await expect(page.locator('.whoami-name')).toHaveText(OTHER.username, { timeout: 20_000 })
  await expect(page.locator('.list-offline')).toHaveCount(0)
  await expect.poll(() => hasDb(page)).toBe(false)
  await expect.poll(() => shellCaches(page)).toEqual([])
})

test('ayar kapatılınca kopya silinir; kapalıyken önbellek yok, sunucu gidince kopyaya geçilmez', async ({ page, server, context }) => {
  seed(server)
  await signIn(page, server.url)
  await enableOffline(page)
  await page.getByRole('button', { name: acct['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(set['set.sec.general'], { exact: true }).click()
  await page.getByLabel(set['set.offline.toggle'], { exact: true }).uncheck()
  await expect.poll(() => hasDb(page)).toBe(false)
  await expect.poll(() => shellCaches(page)).toEqual([])
  await page.keyboard.press('Escape')

  await page.reload()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
  await expect.poll(() => hasDb(page)).toBe(false)
  expect(await shellCaches(page)).toEqual([])
  await goOffline(context, server)
  await page.reload().catch(() => {}) // kabuk önbelleği yok: motor ağ hatası verir ya da hata sayfası açar
  await expect(page.locator('.list-offline')).toHaveCount(0)
})
