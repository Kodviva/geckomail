// Ayarlar › Sunucu filtreleri: web modunda sahte ManageSieve sunucusuyla (src/sync/__tests__/helpers). Uç nokta
// hesap başına sieveSetEndpoint ile verilir. Hesap adresi örnek: IMAP erişilemez, Sieve 127.0.0.1'de ayrı governor'da.
import type { Browser, Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test, type GeckoServer } from './fixtures'
import { makeTestCert, startFakeManageSieve, type FakeSieve, type FakeSieveOptions, type TestCert } from '../src/sync/__tests__/helpers/fakeManageSieve'
import acct from '../src/shared/i18n/locales/tr/acct'
import set from '../src/shared/i18n/locales/tr/set'
import common from '../src/shared/i18n/locales/tr/common'
import auto from '../src/shared/i18n/locales/tr/auto'

const T: Record<string, string> = { ...acct, ...set, ...common, ...auto }
const USER_SCRIPT = 'require "fileinto";\r\nif header :contains "subject" "x" { fileinto "Y"; }\r\n'
const EXT = ['fileinto', 'imap4flags', 'mailbox', 'include', 'vacation', 'date', 'relational']
const SLOW = { timeout: 30_000 } // governor iki login arasında bekletebilir

let cert: TestCert
const fakes: FakeSieve[] = []

test.beforeAll(() => {
  cert = makeTestCert()
})
test.afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()))
})

async function fake(o: Partial<FakeSieveOptions> = {}): Promise<FakeSieve> {
  const f = await startFakeManageSieve({ tls: 'starttls', cert, sasl: ['PLAIN'], extensions: EXT, ...o })
  fakes.push(f)
  return f
}

/** Oturumun çereziyle ikinci kanal: yalnız testin kurulumu için, arayüzde karşılığı olmayan adımlar */
async function call<T = unknown>(page: Page, method: string, params: unknown): Promise<T> {
  return page.evaluate(
    ([m, p]) =>
      new Promise<T>((resolve, reject) => {
        const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/rpc`)
        ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: m, params: p }))
        ws.onerror = () => reject(new Error('rpc kanalı açılamadı'))
        ws.onmessage = (e) => {
          const r = JSON.parse(String(e.data)) as { id?: number; ok?: boolean; result?: T; error?: string }
          if (r.id !== 1) return
          ws.close()
          if (r.ok) resolve(r.result as T)
          else reject(new Error(r.error))
        }
      }),
    [method, params] as const
  )
}

async function signIn(page: Page, username = ADMIN.username, password = ADMIN.password): Promise<void> {
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(password)
  await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(username)
}

/** Hesap açılışta yüklensin diye sunucu yeniden başlar. Parola sunucu anahtarıyla şifrelensin diye RPC ile verilir */
async function setup(page: Page, server: GeckoServer, f: FakeSieve): Promise<number> {
  const accountId = server.withDb((db) => {
    const { accountId: id } = seedMail(db, { email: 'sieve@example.test', messages: [{ subject: 'A' }] })
    db.prepare(`UPDATE accounts SET imap_host = 'imap.example.test', smtp_host = 'smtp.example.test', allow_invalid_certs = 1 WHERE id = ?`).run(id)
    db.prepare(`INSERT INTO folders (account_id, path, kind, special_use) VALUES (?, 'Raporlar', 'other', 0)`).run(id)
    // sunucu modu RPC'den iç adres kabul etmez: sahte sunucu doğrudan satıra yazılır
    db.prepare(`INSERT INTO sieve_accounts (account_id, host, port, updated_at) VALUES (?, '127.0.0.1', ?, 0)`).run(id, f.port)
    return id
  })
  server.setPref('trustedServer', '1')
  await server.stop()
  await server.restartAfterExit()
  await page.goto(server.url)
  await signIn(page)
  await call(page, 'updateAccount', { accountId, patch: { password: 'test-parolasi' } })
  return accountId
}

async function openFilters(page: Page): Promise<void> {
  await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(T['set.sec.filters'], { exact: true }).click()
  await expect(page.getByTestId('sieve-settings')).toBeVisible()
}

const row = (page: Page) => page.getByTestId('sieve-account')
const state = (page: Page) => row(page).getByTestId('sieve-state')
const btn = (page: Page, key: string) => page.getByRole('button', { name: T[key], exact: true })

test('aç, onay ver, kural rozeti, geri al', async ({ page, server }) => {
  const f = await fake()
  f.scripts.set('kisisel', USER_SCRIPT)
  f.active = 'kisisel'
  const accountId = await setup(page, server, f)
  await call(page, 'createRule', {
    name: 'Raporlar kuralı', accountId, groupId: null, conditions: { senderContains: 'rapor' }, actions: [{ type: 'move', folderName: 'Raporlar' }]
  })
  await openFilters(page)

  await btn(page, 'set.sieve.enable').click()
  await expect(page.getByText(T['set.sieve.consent.title'], { exact: true })).toBeVisible(SLOW)
  await expect(page.getByText('kisisel', { exact: false }).first()).toBeVisible()
  await expect(btn(page, 'action.cancel')).toBeFocused()
  await btn(page, 'set.sieve.consent.confirm').click()
  await expect(state(page)).toHaveText(T['set.sieve.state.active'], SLOW)
  expect(f.active).toBe('geckomail-main')
  expect(f.scripts.get('kisisel')).toBe(USER_SCRIPT)

  // kural listesinde rozet
  await page.keyboard.press('Escape')
  await page.locator('.whoami').click()
  await page.getByRole('menuitem', { name: T['acct.panel.automation'] }).click()
  await expect(page.getByTestId('rule-placement')).toHaveText(T['set.sieve.badge.server'])
  await btn(page, 'action.close').last().click()

  await openFilters(page)
  await btn(page, 'set.sieve.rollback').click()
  await expect(state(page)).toHaveText(T['set.sieve.state.off'], SLOW)
  expect(f.active).toBe('kisisel')
  expect(f.scripts.get('kisisel')).toBe(USER_SCRIPT)
  expect(f.scripts.has('geckomail-main')).toBe(false)
})

test('ham düzenleyicide hatalı betik hata satırı gösterir, kayıt yedek alır', async ({ page, server }) => {
  const f = await fake({ checkScript: (c) => (c.includes('bozuk') ? { ok: false, error: 'line 2: unexpected token' } : { ok: true }) })
  f.scripts.set('kisisel', USER_SCRIPT)
  await setup(page, server, f)
  await openFilters(page)
  await btn(page, 'set.sieve.scripts').click(SLOW)
  await page.getByRole('option', { name: 'kisisel' }).click()
  const src = page.getByLabel(T['set.sieve.editor.source'], { exact: true })
  await expect(src).toHaveValue(USER_SCRIPT.replace(/\r\n/g, '\n'))
  await src.fill('bozuk')
  await btn(page, 'set.sieve.editor.check').click()
  await expect(page.getByTestId('sieve-check-result')).toHaveText('line 2: unexpected token', SLOW)
  await btn(page, 'action.save').click()
  await expect(page.getByTestId('sieve-check-result')).toHaveText('line 2: unexpected token', SLOW)
  expect(f.scripts.get('kisisel')).toBe(USER_SCRIPT)

  await src.fill('keep;')
  await btn(page, 'action.save').click()
  await expect.poll(() => f.scripts.get('kisisel'), SLOW).toBe('keep;')
  expect([...f.scripts.keys()].filter((n) => /^kisisel\.bak-\d{12}$/.test(n))).toHaveLength(1)
})

test('tatil çatışması etkin hesapta görünür, kurallar çalışır', async ({ page, server }) => {
  const f = await fake()
  f.scripts.set('kisisel', 'require "vacation";\r\nvacation "dışarıdayım";\r\n')
  f.active = 'kisisel'
  const accountId = await setup(page, server, f)
  await call(page, 'setSieveVacation', {
    accountId, vacation: { enabled: true, subject: 'İzin', body: 'Dönünce yazarım', days: 3, startDate: null, endDate: null }
  })
  await call(page, 'createRule', {
    name: 'Kural', accountId, groupId: null, conditions: { senderContains: 'rapor' }, actions: [{ type: 'move', folderName: 'Raporlar' }]
  })
  await openFilters(page)
  await btn(page, 'set.sieve.enable').click()
  await btn(page, 'set.sieve.consent.confirm').click(SLOW)
  await expect(state(page)).toHaveText(T['set.sieve.state.active'], SLOW)
  await expect(row(page).getByTestId('sieve-detail')).toHaveText(T['set.sieve.detail.vacationConflict'])
  expect(f.scripts.get('geckomail-rules')).not.toContain('vacation')

  await btn(page, 'set.sieve.vacation').click()
  await expect(page.locator('.sieve-dialog')).toContainText(T['set.sieve.detail.vacationConflict'])
  const body = page.locator('.sieve-dialog textarea')
  await body.fill('a\nb')
  await expect(page.getByTestId('sieve-vacation-left')).toHaveText(/3\D?896/) // a CRLF b: 4 bayt, sayı dile göre biçimlenir
  await body.fill('ş'.repeat(1951))
  await expect(btn(page, 'action.save').last()).toBeDisabled()
})

test('375 px genişlikte yatay taşma yok', async ({ page, server }) => {
  const f = await fake()
  f.scripts.set('uzun-adli-kullanici-betigi-uzun-adli-kullanici-betigi', USER_SCRIPT)
  await setup(page, server, f)
  await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
  await page.setViewportSize({ width: 375, height: 812 }) // dar ekranda ayarlar çekmecede: açıkken küçült
  await page.locator('.settings-tabs').getByText(T['set.sec.filters'], { exact: true }).click()
  await expect(btn(page, 'set.sieve.scripts')).toBeVisible(SLOW)
  const overflow = (): Promise<number[]> =>
    page.evaluate(() => {
      const el = document.querySelector('.settings-content')!
      return [document.documentElement.scrollWidth - document.documentElement.clientWidth, el.scrollWidth - el.clientWidth]
    })
  expect(await overflow()).toEqual([0, 0])
  await btn(page, 'set.sieve.enable').click()
  await expect(state(page)).toHaveText(T['set.sieve.state.active'], SLOW)
  expect(await overflow()).toEqual([0, 0])
  await btn(page, 'set.sieve.vacation').click()
  await expect(page.getByTestId('sieve-vacation-left')).toBeVisible()
  const dialog = page.locator('.sieve-dialog')
  const box = await dialog.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(375)
  expect(await overflow()).toEqual([0, 0])
})

test('üye durumu görür, düzenleme düğmesi görmez', async ({ page, server, browser }: { page: Page; server: GeckoServer; browser: Browser }) => {
  const f = await fake()
  const accountId = await setup(page, server, f)
  const group = await call<{ id: number }>(page, 'createGroup', { name: 'Görünen', color: '#111111' })
  await call(page, 'setAccountGroup', { accountId, groupId: group.id })
  const user = await call<{ id: number }>(page, 'createUser', { username: 'uye', password: 'uye-parolasi-1', role: 'member' })
  await call(page, 'setGroupPermission', { userId: user.id, groupId: group.id, canView: true, canManage: false })

  const ctx = await browser.newContext({ locale: 'tr-TR' })
  const member = await ctx.newPage()
  await member.addInitScript(() => localStorage.setItem('gecko-locale', 'tr'))
  await member.goto(server.url)
  await signIn(member, 'uye', 'uye-parolasi-1')
  await openFilters(member)
  await expect(row(member)).toContainText('sieve@example.test')
  await expect(row(member).getByRole('button')).toHaveCount(0)
  await ctx.close()
})
