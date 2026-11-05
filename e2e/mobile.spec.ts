// Mobil arayüz uçtan uca: web paketi __geckoNative sahtesiyle koşar. Sahte eklenti uzun ömürlü belirteci Node tarafında tutar (sayfaya
// girmez); ara vekil gerçek uygulamanın kökenini (https://localhost) taklit eder, böylece Bearer ve bilet yolu gerçek sunucuda sınanır.
import type { Page } from '@playwright/test'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { ADMIN, expect, seedMail, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import mobile from '../src/shared/i18n/locales/tr/mobile'

const T: Record<string, string> = { ...acct, ...mobile }
const APP_ORIGIN = 'https://localhost'

/** Sayfa bu vekilden yüklenir: API ve WebSocket isteklerinde Origin mobil kökene çevrilir. Gerçek uygulamada varlıklar gömülüdür,
 *  sunucudan gelmez: burada varlıklar köken değişmeden geçer */
async function originProxy(target: string): Promise<{ url: string; close(): Promise<void> }> {
  const { hostname, port } = new URL(target)
  const server = http.createServer((req, res) => {
    const up = http.request({ host: hostname, port, method: req.method, path: req.url, headers: { ...req.headers, ...(req.headers.origin && req.url?.startsWith('/api/') ? { origin: APP_ORIGIN } : {}) } }, (r) => {
      res.writeHead(r.statusCode!, r.headers)
      r.pipe(res)
    })
    req.pipe(up)
    up.on('error', () => res.destroy())
  })
  const tunnels = new Set<net.Socket>()
  server.on('upgrade', (req, socket, head) => {
    tunnels.add(socket as net.Socket)
    const up = net.connect(Number(port), hostname, () => {
      const headers = { ...req.headers, origin: APP_ORIGIN }
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${String(v)}`).join('\r\n')}\r\n\r\n`)
      up.write(head)
      socket.pipe(up).pipe(socket)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((r) => {
      for (const s of tunnels) s.destroy()
      server.closeAllConnections()
      server.close(() => r())
    })
  }
}

/** Yerel katman gibi: Origin yok, belirteç yalnız burada */
async function fakeNative(page: Page, server: GeckoServer, o: { lock?: boolean; lockBroken?: boolean } = {}): Promise<void> {
  let token: string | null = null
  // fetch Sec-Fetch-Mode ekler, yerel uçlar reddeder: düz http.request yerel katman gibidir
  const post = (path: string, body?: unknown, bearer?: string): Promise<{ ok: boolean; json(): Promise<unknown> }> =>
    new Promise((resolve, reject) => {
      const u = new URL(server.url)
      const r = http.request(
        { host: u.hostname, port: u.port, method: 'POST', path, headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ ok: res.statusCode! < 300, json: async () => JSON.parse(Buffer.concat(chunks).toString()) }))
        }
      )
      r.on('error', reject)
      r.end(body === undefined ? undefined : JSON.stringify(body))
    })
  await page.exposeFunction('__nativeLogin', async (username: string, password: string) => {
    const r = await post('/api/mobile/login', { username, password })
    if (!r.ok) return { ok: false, reason: 'bad' }
    const b = (await r.json()) as { token: string; user: unknown }
    token = b.token
    return { ok: true, user: b.user }
  })
  await page.exposeFunction('__nativeAccess', async () => {
    if (!token) return { status: 'gone' }
    const r = await post('/api/mobile/token', undefined, token)
    if (!r.ok) return { status: 'gone' }
    const b = (await r.json()) as { accessToken: string; expiresAt: number }
    return { status: 'ok', token: b.accessToken, expiresAt: b.expiresAt }
  })
  await page.exposeFunction('__nativeLogout', async () => {
    const t = token
    token = null
    if (t) await post('/api/mobile/logout', undefined, t)
  })
  await page.addInitScript(({ lock, lockBroken }) => {
    const w = window as unknown as Record<string, (...a: unknown[]) => Promise<unknown>> & { __locks?: number }
    // yerel katman gibi: kilitliyken çıkış kilidi de kapatır
    const lockOn = (): boolean => lock && localStorage.getItem('fake-lock-off') !== '1'
    const plugin = {
      getServer: async () => ({ origin: localStorage.getItem('fake-server') }),
      setServer: async ({ origin }: { origin: string }) => { localStorage.setItem('fake-server', origin) },
      login: ({ username, password }: { username: string; password: string }) => w.__nativeLogin(username, password),
      accessToken: () => w.__nativeAccess(),
      logout: async () => {
        if (lockBroken) localStorage.setItem('fake-lock-off', '1')
        await w.__nativeLogout()
      },
      registerPush: async () => ({ status: 'on' }),
      unregisterPush: async () => {},
      pushStatus: async () => ({ status: 'off' }),
      biometricAvailable: async () => ({ available: true }),
      promptBiometric: async () => {
        w.__locks = (w.__locks ?? 0) + 1
        return { ok: !lockBroken }
      },
      getLock: async () => {
        const state = { enabled: lockOn(), timeoutMs: 0, locked: lockOn() && lockBroken, uptimeMs: performance.now() }
        return state
      },
      setLock: async () => {},
      takePending: async () => {
        const raw = localStorage.getItem('fake-share')
        localStorage.removeItem('fake-share')
        return { opens: [], shares: raw ? [JSON.parse(raw)] : [] }
      },
      sharesDone: async () => { localStorage.setItem('fake-shares-done', '1') },
      addListener: async () => ({ remove: async () => {} })
    }
    ;(globalThis as { __geckoNative?: unknown }).__geckoNative = { plugin, os: 'ios', serverOrigin: localStorage.getItem('fake-server'), dev: true }
    localStorage.setItem('gecko-locale', 'tr')
  }, { lock: !!o.lock, lockBroken: !!o.lockBroken })
}

test.describe('mobil arayüz', () => {
  // arayüz akışı motordan bağımsız; gerçek WKWebView ve Android WebView Görev 11'de
  test.skip(({ browserName }) => browserName !== 'chromium')

  let proxy: Awaited<ReturnType<typeof originProxy>>
  test.beforeEach(async ({ server }) => {
    proxy = await originProxy(server.url)
  })
  test.afterEach(async () => {
    await proxy.close()
  })

  const signIn = async (page: Page): Promise<void> => {
    await page.goto(proxy.url)
    const address = page.getByLabel(T['mobile.server.label'], { exact: true })
    await address.fill(proxy.url)
    await page.getByRole('button', { name: T['mobile.server.connect'], exact: true }).click()
    await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
    await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
    await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  }

  test('sunucu ekranı → giriş → gelen kutusu, belirteç sayfaya girmez', async ({ page, server }) => {
    server.withDb((db) => seedMail(db, { messages: [{ subject: 'Mobil deneme konusu' }] }))
    await fakeNative(page, server)
    await page.goto(proxy.url)
    await expect(page.getByTestId('server-setup')).toBeVisible()

    // üretim kuralı: dev sahtesinde bile geri döngü dışı http yok
    await page.getByLabel(T['mobile.server.label'], { exact: true }).fill('http://posta.example.com')
    await page.getByRole('button', { name: T['mobile.server.connect'], exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText(T['mobile.server.err.insecure'])

    await signIn(page)
    await expect(page.getByText('Mobil deneme konusu').first()).toBeVisible()
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
    expect(stored).not.toMatch(/gma_|gmt_/)
    expect(server.logs()).not.toMatch(/gma_|gmt_/)
  })

  test('giriş ekranı: sunucu görünür, passkey yok, değiştirme onaylıdır', async ({ page, server }) => {
    await fakeNative(page, server)
    await page.goto(proxy.url)
    await page.evaluate((u) => localStorage.setItem('fake-server', u), proxy.url)
    await page.reload()
    await expect(page.getByTestId('login-server')).toContainText(new URL(proxy.url).host)
    await expect(page.getByRole('button', { name: T['acct.login.passkey'], exact: true })).toHaveCount(0)
    page.once('dialog', (d) => void d.dismiss())
    await page.getByRole('button', { name: T['mobile.login.change'], exact: true }).click()
    await expect(page.getByTestId('server-setup')).toHaveCount(0)
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: T['mobile.login.change'], exact: true }).click()
    await expect(page.getByTestId('server-setup')).toBeVisible()
  })

  test('yönetici menüsü yok; ayarlarda tarayıcı düğmesi', async ({ page, server }) => {
    server.withDb((db) => seedMail(db, { messages: [{ subject: 'Konu' }] }))
    await fakeNative(page, server)
    await signIn(page)
    await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
    await expect(page.getByTestId('browser-only')).toContainText(T['mobile.browser.adminTitle'])
    await expect(page.locator('.settings-rail')).not.toContainText('Yedek')
    await expect(page.getByRole('button', { name: T['mobile.browser.open'], exact: true })).toBeVisible()
  })

  test('kilit açılışta içeriği örter, belirteçsiz başlar; arka plandan dönüşte yeniden ister', async ({ page, server }) => {
    server.withDb((db) => seedMail(db, { messages: [{ subject: 'Kilitli konu' }] }))
    await fakeNative(page, server, { lock: true })
    await page.goto(proxy.url)
    await page.evaluate((u) => localStorage.setItem('fake-server', u), proxy.url)
    await signIn2(page)
    await expect(page.getByText('Kilitli konu').first()).toBeVisible()
    const before = await page.evaluate(() => (window as unknown as { __locks?: number }).__locks ?? 0)
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('gecko:app-state', { detail: { active: false } })))
    await expect(page.getByTestId('app-lock')).toBeVisible()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('gecko:app-state', { detail: { active: true } })))
    await expect(page.getByTestId('app-lock')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __locks?: number }).__locks)).toBeGreaterThan(before)
    await expect(page.getByText('Kilitli konu').first()).toBeVisible()
  })

  test('paylaşım girişi bekler, sonra oluşturucuda ek olur', async ({ page, server }) => {
    server.withDb((db) => seedMail(db, { messages: [{ subject: 'Konu' }] }))
    await fakeNative(page, server)
    await page.route('**/_capacitor_file_/**', (r) => r.fulfill({ body: 'pdf' }))
    await page.goto(proxy.url)
    await page.evaluate((u) => {
      localStorage.setItem('fake-server', u)
      localStorage.setItem('fake-share', JSON.stringify({ files: [{ name: 'rapor.pdf', uploadPath: '/_capacitor_file_/s/0', mime: 'application/pdf' }], text: 'paylaşılan not' }))
    }, proxy.url)
    await page.reload()
    await expect(page.getByLabel(T['acct.common.username'], { exact: true })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('fake-share'))).not.toBeNull() // girişten önce alınmaz
    await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
    await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
    await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
    await expect(page.getByText('rapor.pdf')).toBeVisible()
    await expect(page.locator('textarea').first()).toHaveValue(/paylaşılan not/)
    expect(await page.evaluate(() => localStorage.getItem('fake-shares-done'))).toBe('1')
  })

  test('açılamayan kilit: çıkış yap posta göstermeden giriş ekranına götürür, yeniden giriş kilide takılmaz', async ({ page, server }) => {
    server.withDb((db) => seedMail(db, { messages: [{ subject: 'Gizli konu' }] }))
    await fakeNative(page, server, { lock: true, lockBroken: true })
    await page.goto(proxy.url)
    await page.evaluate((u) => localStorage.setItem('fake-server', u), proxy.url)
    await page.reload()
    const lock = page.getByTestId('app-lock')
    const signOut = lock.getByRole('button', { name: T['mobile.lock.signOut'], exact: true })
    await expect(signOut).toBeVisible()
    await expect(page.getByText('Gizli konu')).toHaveCount(0)

    // vazgeçilen çıkış kilidi açmaz
    page.once('dialog', (d) => void d.dismiss())
    await signOut.click()
    await expect(lock).toBeVisible()

    page.once('dialog', (d) => void d.accept())
    await signOut.click()
    await expect(page.getByLabel(T['acct.common.username'], { exact: true })).toBeVisible()
    await expect(page.getByTestId('app-lock')).toHaveCount(0)
    await expect(page.getByText('Gizli konu')).toHaveCount(0)

    await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
    await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
    await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
    await expect(page.getByText('Gizli konu').first()).toBeVisible()
    await expect(page.getByTestId('app-lock')).toHaveCount(0)
  })

  const signIn2 = async (page: Page): Promise<void> => {
    await page.reload()
    await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
    await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
    await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  }
})
