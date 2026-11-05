// Tarayıcı push uçtan uca: gerçek push servisi test ortamında yok, abonelik sahte servise yönlenir. Sunucu yükü
// şifreli gönderir, test RFC 8291 ile çözer (tarayıcının yerine) ve CDP ile service worker'a teslim eder. Bu
// yalnız Chromium'da var: Firefox ve WebKit'te atlanır (derin bağlantı üç motorda: deepLink.spec.ts). Başsız kabukta
// (headless shell) bildirim izni hep 'denied' olduğundan tam Chromium'un başsız kipi kullanılır.
import { createECDH, randomBytes, type ECDH } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BrowserContext, CDPSession, Locator, Page, Worker } from '@playwright/test'
import { ADMIN, expect, seedMail, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import set from '../src/shared/i18n/locales/tr/set'
import sync from '../src/shared/i18n/locales/tr/sync'
import { decryptPush } from '../src/server/__tests__/pushTestUtil'

const T: Record<string, string> = { ...acct, ...set }

async function signIn(page: Page): Promise<void> {
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
}

const seed = (server: GeckoServer): { accountId: number; messageId: number } => {
  const r = server.withDb((db) => {
    const m = seedMail(db, { messages: [{ subject: 'Bildirimli ileti' }, { subject: 'Başka ileti', seen: true }] })
    db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, 'Gövde', NULL, ?, ?, 5)`)
      .run(m.messageIds[0], Date.now(), Date.now())
    return m
  })
  return { accountId: r.accountId, messageId: r.messageIds[0] }
}

/** Sayfa tarafında push servisi: abonelik testin anahtarlarıyla sahte servise yönlenir. İptal yenilemeden sağ çıksın
 *  diye localStorage'a yazılır */
async function stubPushManager(page: Page, endpoint: string, ua: ECDH, auth: Buffer): Promise<void> {
  await page.addInitScript(({ endpoint, p256dh, auth }) => {
    const sub = {
      endpoint, options: { applicationServerKey: null },
      toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
      unsubscribe: async () => {
        localStorage.removeItem('e2e-sub')
        localStorage.setItem('e2e-unsub', '1')
        return true
      }
    }
    PushManager.prototype.subscribe = (async () => {
      localStorage.setItem('e2e-sub', '1')
      return sub
    }) as unknown as PushManager['subscribe']
    PushManager.prototype.getSubscription = (async () => (localStorage.getItem('e2e-sub') ? sub : null)) as unknown as PushManager['getSubscription']
  }, { endpoint, p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') })
}

async function fakePushService(): Promise<{ url: string; bodies: Buffer[]; close(): Promise<void> }> {
  const bodies: Buffer[] = []
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks))
      res.statusCode = 201
      res.end()
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/gonder/1`, bodies,
    close: () => new Promise((r) => {
      srv.closeAllConnections()
      srv.close(() => r())
    })
  }
}

async function openNotifySettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(T['set.sec.notify'], { exact: true }).click()
}

const pushToggle = (page: Page): Locator => page.getByRole('checkbox', { name: T['set.notify.pushToggle'], exact: true })

async function turnOnPush(page: Page): Promise<void> {
  await openNotifySettings(page)
  const toggle = pushToggle(page)
  await toggle.click() // durum abonelik bitince değişir: check() hemen bakardı
  await expect(toggle).toBeChecked()
  await page.keyboard.press('Escape')
}

const deviceCount = (server: GeckoServer): number =>
  server.withDb((db) => (db.prepare(`SELECT COUNT(*) AS n FROM push_devices`).get() as { n: number }).n)

/** Aktif service worker ve CDP teslim işlevi */
async function pushChannel(context: BrowserContext, page: Page, origin: string): Promise<{ sw: Worker; deliver(data: string): Promise<void> }> {
  const cdp: CDPSession = await context.newCDPSession(page)
  const registrationId = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
      const r = registrations.find((x) => x.scopeURL.startsWith(origin))
      if (r) resolve(r.registrationId)
    })
  })
  await cdp.send('ServiceWorker.enable')
  const id = await registrationId
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  return { sw, deliver: async (data) => void (await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: id, data })) }
}

/** Ana tsconfig'te WebWorker kütüphanesi yok */
type SwScope = { registration: ServiceWorkerRegistration; NotificationEvent: new (t: string, o: unknown) => Event; dispatchEvent(e: Event): boolean }

const shownNotifications = (sw: Worker): Promise<{ title: string; tag: string; actions: string[] }[]> =>
  sw.evaluate(async () => {
    const list = await (self as unknown as SwScope).registration.getNotifications()
    return list.map((n) => ({ title: n.title, tag: n.tag, actions: ((n as unknown as { actions: { title: string }[] }).actions ?? []).map((a) => a.title) }))
  })

/** Pencere kapandıktan sonra SW onu bir an daha görebilir (bastırır): gösterilene dek yinelenir, etiket tek bildirimde tutar */
const showWhenNoWindow = (sw: Worker, deliver: () => Promise<void>): Promise<void> =>
  expect(async () => {
    await deliver()
    expect(await shownNotifications(sw)).toHaveLength(1)
  }).toPass({ timeout: 10_000 })

/** Chromium'da showNotification sürerken çağrılan getNotifications yeni bildirimi listeden kalıcı düşürür (GeckoMail'siz
 *  yinelenir): sekmenin gösterimi bitmeden shownNotifications çağrılmaz. Sayfa açılmadan önce kurulur */
const trackTabShows = (page: Page): Promise<unknown> =>
  page.addInitScript(() => {
    const proto = ServiceWorkerRegistration.prototype
    const show = proto.showNotification
    proto.showNotification = async function (this: ServiceWorkerRegistration, ...a: Parameters<typeof show>) {
      await show.apply(this, a)
      const w = window as unknown as { e2eShown?: number }
      w.e2eShown = (w.e2eShown ?? 0) + 1
    }
  })

const tabShown = (page: Page): Promise<unknown> => page.waitForFunction(() => (window as unknown as { e2eShown?: number }).e2eShown === 1)

/** Bildirim tıklaması: işletim sistemi tıklamasının yerine aynı olay (focus izni yok, SW bunu yutar) */
const clickNotification = (sw: Worker, action = ''): Promise<void> =>
  sw.evaluate(async (action) => {
    const scope = self as unknown as SwScope
    const [n] = await scope.registration.getNotifications()
    try {
      scope.dispatchEvent(new scope.NotificationEvent('notificationclick', { notification: n, action }))
    } catch {
      /* elle gönderilen olayda waitUntil reddedilir; işleyici çoktan çalıştı */
    }
  }, action)

// macOS'ta bildirimler sistem merkezine gider ve merkez aynı uygulamanın bütün süreçlerince paylaşılır: paralel başka
// bir tarayıcı gizli bağlamını kapatınca bu bağlamın bildirimi de silinir, getNotifications boş döner (GeckoMail'siz
// yinelenir). Bildirim tarayıcıda kalsın. Bu anahtar Playwright'ın öntanımlı --disable-features listesinin yerine geçer
test.use({ pushService: true, channel: 'chromium', launchOptions: { args: ['--disable-features=SystemNotifications'] } })
test.skip(({ browserName }) => browserName !== 'chromium', 'ServiceWorker.deliverPushMessage yalnız CDP ile (Chromium)')

test.describe('push teslimi', () => {
  test('şifreli yük çözülür, bildirim görünür, tıklama iletiyi açar', async ({ context, page, server }) => {
    const { accountId, messageId } = seed(server)
    const push = await fakePushService()
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = randomBytes(16)
    await stubPushManager(page, push.url, ua, auth)
    await context.grantPermissions(['notifications'], { origin: server.url })
    try {
      await page.goto(server.url)
      await signIn(page)
      await turnOnPush(page)
      await expect.poll(() => deviceCount(server)).toBe(1)
      const { sw, deliver } = await pushChannel(context, page, server.url)

      const item = { title: 'Ali', body: 'Bildirimli ileti', accountId, messageId, level: 'normal' as const, tag: 'etiket-1', count: 1 }
      server.deliver(1, item)
      await expect.poll(() => push.bodies.length).toBe(1)
      const plain = decryptPush(push.bodies[0], ua, auth).toString('utf-8')
      expect(JSON.parse(plain)).toMatchObject({ title: 'Ali', messageId, actions: [{ action: 'read' }, { action: 'archive' }, { action: 'reply' }] })
      // gövde sunucudan şifreli çıkar: konu düz metin görünmez
      expect(push.bodies[0].includes('Bildirimli')).toBe(false)

      // odaktaki pencere varken gösterilmez
      await deliver(plain)
      await page.waitForTimeout(500)
      expect(await shownNotifications(sw)).toEqual([])

      // pencere kapalı: gösterilir, eylem düğmeleri kullanıcının dilinde
      const other = await context.newPage()
      await page.goto('about:blank')
      await showWhenNoWindow(sw, () => deliver(plain))
      const [shown] = await shownNotifications(sw)
      // Chrome en çok iki düğme gösterir (Notification.maxActions): yanıtla yükte var, sırada üçüncü
      expect(shown).toMatchObject({ title: 'Ali', actions: [sync['sync.notify.action.read'], sync['sync.notify.action.archive']] })

      // açık pencere yeniden yüklenmeden iletiyi açar
      await other.goto(server.url)
      await expect(other.locator('.whoami-name')).toHaveText(ADMIN.username)
      await expect(other.locator('.msg-row').first()).toBeVisible()
      await clickNotification(sw)
      await expect(other.getByText('Gövde', { exact: true })).toBeVisible()
      await expect.poll(() => shownNotifications(sw)).toEqual([])
    } finally {
      await push.close()
    }
  })

  test('push kilidi bekler: bırakılınca, bırakılmazsa süre dolunca gösterilir', async ({ context, page, server }) => {
    const { accountId, messageId } = seed(server)
    const push = await fakePushService()
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    await stubPushManager(page, push.url, ua, randomBytes(16))
    await context.grantPermissions(['notifications'], { origin: server.url })
    try {
      await page.goto(server.url)
      await signIn(page)
      await turnOnPush(page)
      const { sw, deliver } = await pushChannel(context, page, server.url)
      await context.newPage()
      await page.goto('about:blank')
      const payload = (tag: string): string => JSON.stringify({ title: 'Ali', body: tag, accountId, messageId, level: 'normal', tag, count: 1, actions: [] })
      // pencere kapandı: buradan sonra SW bastırmaz
      await showWhenNoWindow(sw, () => deliver(payload('isinma')))
      const hold = (tag: string): Promise<void> =>
        sw.evaluate((tag) => new Promise<void>((held) => {
          void navigator.locks.request(`gecko-notify:${tag}`, () => new Promise<void>((release) => {
            (self as unknown as { e2eRelease: () => void }).e2eRelease = release
            held()
          }))
        }), tag)

      await hold('kilitli')
      const pending = deliver(payload('kilitli'))
      await page.waitForTimeout(800)
      expect(await shownNotifications(sw)).toHaveLength(1)
      await sw.evaluate(() => (self as unknown as { e2eRelease: () => void }).e2eRelease())
      await pending
      await expect.poll(() => shownNotifications(sw)).toHaveLength(2)

      // kilit sahibi takılı kalsa da bildirim kaybolmaz
      await hold('takili')
      await deliver(payload('takili'))
      await expect.poll(() => shownNotifications(sw), { timeout: 10_000 }).toHaveLength(3)
    } finally {
      await push.close()
    }
  })

  /** Bildirim pencere yokken gösterilir, sonra uygulama açılır: eylemin etkisi açık pencereye messages:changed ile ulaşır */
  async function actionFromNotification(context: BrowserContext, page: Page, server: GeckoServer, action: 'read' | 'archive'): Promise<{ other: Page; row: Locator; messageId: number; click(): Promise<void> }> {
    const { accountId, messageId } = seed(server)
    await page.goto(server.url)
    await signIn(page)
    await turnOnPush(page)
    const { sw, deliver } = await pushChannel(context, page, server.url)
    const other = await context.newPage()
    await page.goto('about:blank')
    const payload = JSON.stringify({
      title: 'Ali', body: 'x', accountId, messageId, level: 'normal', tag: `etiket-${action}`, count: 1,
      actions: [{ action, title: 'Eylem' }]
    })
    await showWhenNoWindow(sw, () => deliver(payload))
    await other.goto(server.url)
    await expect(other.locator('.whoami-name')).toHaveText(ADMIN.username)
    const row = other.locator('.msg-row', { hasText: 'Bildirimli ileti' })
    await expect(row).toBeVisible()
    return { other, row, messageId, click: () => clickNotification(sw, action) }
  }

  test('bildirimden okundu: sunucuda işlenir, açık pencerede liste güncellenir', async ({ context, page, server }) => {
    const push = await fakePushService()
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    await stubPushManager(page, push.url, ua, randomBytes(16))
    await context.grantPermissions(['notifications'], { origin: server.url })
    try {
      const { row, messageId, click } = await actionFromNotification(context, page, server, 'read')
      await expect(row).toHaveClass(/\bunread\b/)
      await click()
      const seen = (): number => server.withDb((db) => (db.prepare(`SELECT seen FROM messages WHERE id = ?`).get(messageId) as { seen: number }).seen)
      await expect.poll(seen).toBe(1)
      await expect(row).not.toHaveClass(/\bunread\b/)
    } finally {
      await push.close()
    }
  })

  test('bildirimden arşiv: sunucuda işlenir, ileti açık pencerede listeden düşer', async ({ context, page, server }) => {
    const push = await fakePushService()
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    await stubPushManager(page, push.url, ua, randomBytes(16))
    await context.grantPermissions(['notifications'], { origin: server.url })
    try {
      const { row, messageId, click } = await actionFromNotification(context, page, server, 'archive')
      await click()
      const hidden = (): number => server.withDb((db) => (db.prepare(`SELECT hidden FROM messages WHERE id = ?`).get(messageId) as { hidden: number }).hidden)
      await expect.poll(hidden).toBe(1)
      await expect(row).toHaveCount(0)
    } finally {
      await push.close()
    }
  })

  test('sunucu kaydı ölü: sekme odakta değilken bildirim yine görünür, tıklama iletiyi açar', async ({ context, page, server }) => {
    const { accountId, messageId } = seed(server)
    const push = await fakePushService()
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    await stubPushManager(page, push.url, ua, randomBytes(16))
    await trackTabShows(page)
    await context.grantPermissions(['notifications'], { origin: server.url })
    try {
      await page.goto(server.url)
      await signIn(page)
      await turnOnPush(page)
      await expect.poll(() => deviceCount(server)).toBe(1)
      const { sw } = await pushChannel(context, page, server.url)
      server.withDb((db) => db.prepare(`DELETE FROM push_devices`).run()) // 410, sınırdan düşme ya da başka cihazdan silme
      await page.evaluate(() => {
        document.hasFocus = () => false
      })
      server.deliver(1, { title: 'Ali', body: 'Bildirimli ileti', accountId, messageId, level: 'normal', tag: 'etiket-olu', count: 1 })
      await tabShown(page)
      expect((await shownNotifications(sw)).map((n) => n.title)).toEqual(['Ali'])
      expect(push.bodies).toHaveLength(0)
      await clickNotification(sw)
      await expect(page.getByText('Gövde', { exact: true })).toBeVisible()
      await expect.poll(() => shownNotifications(sw)).toEqual([])
      // ayarlar anahtarı sunucudaki durumu gösterir
      await openNotifySettings(page)
      await expect(pushToggle(page)).not.toBeChecked()
    } finally {
      await push.close()
    }
  })

  test('bu cihaz listeden kaldırılır: güçlü onay, abonelik iptal, anahtar kapanır, yeniden kaydolmaz', async ({ context, page, server }) => {
    seed(server)
    const push = await fakePushService()
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    await stubPushManager(page, push.url, ua, randomBytes(16))
    await context.grantPermissions(['notifications'], { origin: server.url })
    try {
      await page.goto(server.url)
      await signIn(page)
      await turnOnPush(page)
      await expect.poll(() => deviceCount(server)).toBe(1)
      await openNotifySettings(page)
      const asked: string[] = []
      page.on('dialog', (d) => {
        asked.push(d.message())
        void d.accept()
      })
      await page.getByTestId('notify-devices').getByRole('button', { name: new RegExp(`^${T['set.nd.remove']}:`) }).click()
      await expect(pushToggle(page)).not.toBeChecked()
      expect(asked).toHaveLength(1)
      expect(asked[0]).toContain(T['set.nd.removeCurrentConfirm'].split(':')[0])
      await expect.poll(() => page.evaluate(() => localStorage.getItem('e2e-unsub'))).toBe('1')
      expect(deviceCount(server)).toBe(0)
      await page.reload()
      await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
      await page.waitForTimeout(500)
      expect(deviceCount(server)).toBe(0)
    } finally {
      await push.close()
    }
  })

  test('pushsubscriptionchange: service worker yeni aboneliği çerezle kaydeder', async ({ context, page, server }) => {
    seed(server)
    const push = await fakePushService()
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    await stubPushManager(page, push.url, ua, randomBytes(16))
    await context.grantPermissions(['notifications'], { origin: server.url })
    try {
      await page.goto(server.url)
      await signIn(page)
      await turnOnPush(page)
      await expect.poll(() => deviceCount(server)).toBe(1)
      const { sw } = await pushChannel(context, page, server.url)
      // gerçek dönüşüm üretilemez: tarayıcının verdiği yeni abonelik olaya elle konur
      await sw.evaluate(({ endpoint, p256dh, auth }) => {
        const scope = self as unknown as SwScope & { ExtendableEvent: new (t: string) => Event }
        const e = Object.assign(new scope.ExtendableEvent('pushsubscriptionchange'), {
          newSubscription: { toJSON: () => ({ endpoint, keys: { p256dh, auth } }) }
        })
        try {
          scope.dispatchEvent(e)
        } catch {
          /* elle gönderilen olayda waitUntil reddedilir; işleyici çoktan çalıştı */
        }
      }, { endpoint: `${push.url}-yeni`, p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') })
      await expect.poll(() => deviceCount(server)).toBe(2)
      const label = server.withDb((db) => (db.prepare(`SELECT label FROM push_devices ORDER BY id DESC LIMIT 1`).get() as { label: string | null }).label)
      expect(label).toMatch(/^Chrome · /)
    } finally {
      await push.close()
    }
  })

  test('oturumsuz açılış: önceki oturumdan kalan abonelik iptal edilir', async ({ context, page, server }) => {
    seed(server)
    const push = await fakePushService()
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    await stubPushManager(page, push.url, ua, randomBytes(16))
    await context.grantPermissions(['notifications'], { origin: server.url })
    try {
      await page.goto(server.url)
      await signIn(page)
      await turnOnPush(page)
      await expect.poll(() => deviceCount(server)).toBe(1)
      await page.keyboard.press('Escape')
      await context.clearCookies()
      await page.reload()
      await expect(page.getByRole('button', { name: T['acct.login.signIn'], exact: true })).toBeVisible()
      await expect.poll(() => page.evaluate(() => localStorage.getItem('e2e-sub'))).toBeNull()
      expect(await page.evaluate(() => localStorage.getItem('e2e-unsub'))).toBe('1')
    } finally {
      await push.close()
    }
  })

  test('çıkışta abonelik yenilemeden önce iptal edilir, cihaz silinir, yeniden girişte geri gelir', async ({ context, page, server }) => {
    seed(server)
    const push = await fakePushService()
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    await stubPushManager(page, push.url, ua, randomBytes(16))
    await context.grantPermissions(['notifications'], { origin: server.url })
    try {
      await page.goto(server.url)
      await signIn(page)
      await turnOnPush(page)
      await expect.poll(() => deviceCount(server)).toBe(1)
      await page.locator('.whoami').click()
      await page.getByRole('menuitem', { name: T['acct.panel.logout'] }).click()
      await expect(page.getByRole('button', { name: T['acct.login.signIn'], exact: true })).toBeVisible()
      expect(await page.evaluate(() => localStorage.getItem('e2e-unsub'))).toBe('1')
      expect(deviceCount(server)).toBe(0)
      await signIn(page)
      await expect.poll(() => deviceCount(server)).toBe(1)
    } finally {
      await push.close()
    }
  })
})
