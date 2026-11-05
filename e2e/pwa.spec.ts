// PWA uçtan uca: manifest ve ikonlar servis edilir, Chromium'da uygulama yüklenebilir ve service worker kaydolur;
// sekme başlığı okunmamış sayısını izler; yükleme önerisi ve bildirim izni kurallara uyar; oturum dili her
// bağlantıya ayrıdır.
import type { Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import acctEn from '../src/shared/i18n/locales/en/acct'
import set from '../src/shared/i18n/locales/tr/set'
import syncTr from '../src/shared/i18n/locales/tr/sync'
import syncEn from '../src/shared/i18n/locales/en/sync'

const T: Record<string, string> = { ...acct, ...set }

async function signIn(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
}

/** Hesapsız kullanıcıya içe aktarma penceresi açılır (arayüzü örter): en az bir hesap */
const seedAccount = (server: GeckoServer): void => {
  server.withDb((db) => seedMail(db, { messages: [{ subject: 'Örnek', seen: true }] }))
}

async function openNotifySettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(T['set.sec.notify'], { exact: true }).click()
}

/** Tarayıcı olayının yerine geçer: gerçek tetikleme motorun sezgisine bağlı, üç tarayıcıda öneri akışı denenir */
const fireInstallPrompt = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true })
    Object.assign(e, { prompt: async () => {}, userChoice: Promise.resolve({ outcome: 'dismissed' }) })
    window.dispatchEvent(e)
  })

test('manifest geçerli JSON, ikonları servis ediliyor', async ({ request, server }) => {
  const r = await request.get(`${server.url}/manifest.webmanifest`)
  expect(r.status()).toBe(200)
  expect(r.headers()['content-type']).toContain('application/manifest+json')
  expect(r.headers()['cache-control']).toBe('no-cache')
  const m = (await r.json()) as { name: string; short_name: string; start_url: string; display: string; icons: { src: string; sizes: string; purpose: string }[] }
  expect(m).toMatchObject({ name: 'GeckoMail', short_name: 'GeckoMail', start_url: '/', display: 'standalone' })
  expect(m.icons.map((i) => `${i.sizes} ${i.purpose}`).sort()).toEqual(['192x192 any', '512x512 any', '512x512 maskable'])
  for (const i of m.icons) {
    const png = await request.get(`${server.url}${i.src}`)
    expect(png.status(), i.src).toBe(200)
    expect(png.headers()['content-type']).toBe('image/png')
    expect((await png.body()).length).toBeGreaterThan(500)
  }
})

test('/sw.js kökte, yeniden doğrulamalı', async ({ request, server }) => {
  const r = await request.get(`${server.url}/sw.js`)
  expect(r.status()).toBe(200)
  expect(r.headers()['content-type']).toContain('text/javascript')
  expect(r.headers()['cache-control']).toBe('no-cache')
  const js = await r.text()
  expect(js).toContain('skipWaiting')
  // sınıflandırılmamış betik: import/export içermez; kabuk listesi derlemede yazılmış olmalı
  expect(js).not.toMatch(/^\s*(import|export)\s/m)
  expect(js).not.toContain('__GECKO_SHELL__')
})

test('service worker kaydolur, uygulama yüklenebilir (Chromium)', async ({ page, server, browserName, context }) => {
  test.skip(browserName !== 'chromium', 'yüklenebilirlik denetimi CDP ile, yalnız Chromium')
  const csp: string[] = []
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) csp.push(m.text())
  })
  await page.goto(server.url)
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(scope).toBe(`${server.url}/`)
  // clients.claim: sayfa yenilenmeden denetime girer
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)

  const cdp = await context.newCDPSession(page)
  const manifest = await cdp.send('Page.getAppManifest', {})
  expect(manifest.errors).toEqual([])
  expect(manifest.url).toBe(`${server.url}/manifest.webmanifest`)
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors')
  expect(installabilityErrors).toEqual([])
  expect(csp).toEqual([])
})

test('sekme başlığı okunmamış sayısını izler, çıkışta temizlenir', async ({ page, server }) => {
  server.withDb((db) =>
    seedMail(db, {
      messages: [{ subject: 'Okunmamış bir' }, { subject: 'Okunmamış iki' }, { subject: 'Okunmamış üç' }, { subject: 'Okunmuş', seen: true }]
    })
  )
  await signIn(page, server.url)
  await expect(page).toHaveTitle('(3) GeckoMail')

  await page.getByText('Okunmamış iki').first().click()
  await expect(page).toHaveTitle('(2) GeckoMail')

  await page.locator('.whoami').click()
  await page.getByRole('menuitem', { name: T['acct.panel.logout'] }).click()
  await expect(page.getByRole('button', { name: T['acct.login.signIn'], exact: true })).toBeVisible()
  await expect(page).toHaveTitle('GeckoMail')
})

test('yükleme önerisi: "Şimdi değil" bir hafta, "Bir daha sorma" kalıcı', async ({ page, server }) => {
  seedAccount(server)
  await signIn(page, server.url)
  const banner = page.locator('.install-banner')
  await expect(banner).toHaveCount(0) // olay gelmeden öneri yok

  await fireInstallPrompt(page)
  await expect(banner).toContainText(T['set.pwa.installText'])
  await banner.getByRole('button', { name: T['set.pwa.notNow'], exact: true }).click()
  await expect(banner).toHaveCount(0)
  const until = Number(await page.evaluate(() => localStorage.getItem('gecko-pwa-prompt')))
  expect(until).toBeGreaterThan(Date.now() + 6 * 86_400_000)

  await page.reload()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
  await fireInstallPrompt(page)
  await expect(banner).toHaveCount(0) // ertelendi

  await page.evaluate(() => localStorage.removeItem('gecko-pwa-prompt'))
  await fireInstallPrompt(page)
  await banner.getByRole('button', { name: T['set.pwa.never'], exact: true }).click()
  await expect(banner).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('gecko-pwa-prompt'))).toBe('never')
})

test('bildirim izni kendiliğinden istenmez, yalnız ayarlardan', async ({ page, server }) => {
  // tarayıcıların izin penceresi otomasyonda açılamaz: akış sahte Notification ile denenir
  await page.addInitScript(() => {
    class Fake {
      static permission = 'default'
      static asked = 0
      static async requestPermission() {
        Fake.asked++
        Fake.permission = 'granted'
        return 'granted'
      }
    }
    Object.defineProperty(window, 'Notification', { value: Fake, configurable: true })
  })
  seedAccount(server)
  const asked = () => page.evaluate(() => (window as unknown as { Notification: { asked: number } }).Notification.asked)
  await signIn(page, server.url)
  expect(await asked()).toBe(0)

  await openNotifySettings(page)
  const toggle = page.getByLabel(T['set.notify.webToggle'], { exact: true })
  await expect(toggle).not.toBeChecked()
  expect(await asked()).toBe(0)

  await toggle.check()
  await expect(toggle).toBeChecked()
  expect(await asked()).toBe(1)

  await toggle.uncheck()
  await expect(toggle).not.toBeChecked()
  await toggle.check()
  await expect(toggle).toBeChecked()
  expect(await asked()).toBe(1) // izin varken yeniden sorulmaz
})

test('izin engellenmişse anahtar kapalı, açıklama gösterilir', async ({ page, server }) => {
  // başsız Chromium grantPermissions'a rağmen Notification.permission 'denied' döner: üç tarayıcıda sahteyle
  seedAccount(server)
  await page.addInitScript(() => {
    Object.defineProperty(window, 'Notification', { value: { permission: 'denied' }, configurable: true })
  })
  await signIn(page, server.url)
  await openNotifySettings(page)
  await expect(page.getByLabel(T['set.notify.webToggle'], { exact: true })).toBeDisabled()
  await expect(page.getByText(T['set.notify.webDenied'], { exact: true })).toBeVisible()
})

test('arayüz bağlanınca dilini oturuma bildirir', async ({ page, server }) => {
  const sent: string[] = []
  page.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(String(f.payload))))
  await page.addInitScript(() => localStorage.setItem('gecko-locale', 'en'))
  await page.goto(server.url)
  await page.getByLabel(acctEn['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(acctEn['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: acctEn['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
  await expect.poll(() => sent.find((s) => s.includes('setSessionLocale')) ?? '').toContain('"locale":"en"')
})

test('oturum dili: iki bağlantı aynı hatayı kendi dilinde alır', async ({ page, server }) => {
  await signIn(page, server.url)
  const errors = await page.evaluate(async () => {
    const open = (): Promise<WebSocket> =>
      new Promise((res, rej) => {
        const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/rpc`)
        ws.onopen = () => res(ws)
        ws.onerror = () => rej(new Error('bağlanamadı'))
      })
    const call = (ws: WebSocket, id: number, method: string, params: unknown): Promise<{ ok: boolean; error?: string }> =>
      new Promise((res) => {
        const onMsg = (e: MessageEvent): void => {
          const m = JSON.parse(String(e.data)) as { id?: number; ok: boolean; error?: string }
          if (m.id !== id) return
          ws.removeEventListener('message', onMsg)
          res(m)
        }
        ws.addEventListener('message', onMsg)
        ws.send(JSON.stringify({ id, method, params }))
      })
    const [a, b] = await Promise.all([open(), open()])
    await call(a, 1, 'setSessionLocale', { locale: 'en' })
    await call(b, 1, 'setSessionLocale', { locale: 'tr' })
    const [ra, rb] = await Promise.all([call(a, 2, 'yokYontem', {}), call(b, 2, 'yokYontem', {})])
    a.close()
    b.close()
    return [ra.error, rb.error]
  })
  expect(errors).toEqual([
    syncEn['sync.err.unknownMethod'].replace('{method}', 'yokYontem'),
    syncTr['sync.err.unknownMethod'].replace('{method}', 'yokYontem')
  ])
})
