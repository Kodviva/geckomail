// Masaüstü sunucu modu: Electron penceresi sunucunun web istemcisini köprüyle yükler. Burada aynı platform dalı mevcut tarayıcı
// ve derlenmiş sunucuyla sınanır (köprü taklitle verilir). Electron penceresinin kendisi smoke ve el testinde.
import type { CDPSession, Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import common from '../src/shared/i18n/locales/tr/common'
import set from '../src/shared/i18n/locales/tr/set'
import { base32Decode, totpCode } from '../src/sync/auth/totp'

const T: Record<string, string> = { ...acct, ...common, ...set }

type Calls = { opened: number; system: string[]; push: unknown[]; ready: number; emit?: (e: { event: string; data: unknown }) => void }

async function installBridge(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const calls: Calls = { opened: 0, system: [], push: [], ready: 0 }
    Object.assign(window, {
      __calls: calls,
      geckoDesktop: {
        wallboard: { open: async () => { calls.opened++ }, push: (s: unknown) => void calls.push.push(s) },
        openSystemBrowser: async (p: string) => void calls.system.push(p),
        onLocalEvent: (cb: Calls['emit']) => { calls.emit = cb },
        rendererReady: () => { calls.ready++ }
      }
    })
  })
}

async function signIn(page: Page, server: GeckoServer): Promise<void> {
  await page.goto(server.url)
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
}

const signedIn = (page: Page) => expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
const openSettings = (page: Page) => page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()

test.beforeEach(async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { messages: [{ subject: 'Merhaba' }] }))
  await installBridge(page)
})

test('parolayla giriş; menü olayı taşımadan geçer; bildirim ve push ayarı görünmez', async ({ page, server }) => {
  await signIn(page, server)
  await signedIn(page)
  await page.evaluate(() => (window as unknown as { __calls: Calls }).__calls.emit!({ event: 'local:menu', data: { action: 'settings' } }))
  await page.locator('.settings-rail').getByText(T['set.sec.notify'], { exact: true }).click()
  await expect(page.getByTestId('notify-devices')).toBeVisible()
  await expect(page.getByLabel(T['set.notify.webToggle'], { exact: true })).toHaveCount(0)
  await expect(page.getByLabel(T['set.notify.pushToggle'], { exact: true })).toHaveCount(0)
  await expect(page.getByTestId('server-connect')).toHaveCount(0) // geçiş köprüsü yalnız yerel modda
})

test('duvar modu köprüden açılır ve veri gönderir', async ({ page, server }) => {
  await signIn(page, server)
  await signedIn(page)
  await page.getByRole('button', { name: T['acct.panel.wallboard'], exact: true }).click()
  const calls = () => page.evaluate(() => {
    const c = (window as unknown as { __calls: Calls }).__calls
    return { opened: c.opened, pushed: c.push.length }
  })
  await expect.poll(calls).toMatchObject({ opened: 1 })
  await expect.poll(async () => (await calls()).pushed).toBeGreaterThan(0)
})

test('TOTP ile giriş', async ({ page, server }) => {
  await signIn(page, server)
  await signedIn(page)
  await openSettings(page)
  await page.locator('.settings-rail').getByText(T['set.sec.vault'], { exact: true }).click()
  const box = page.getByTestId('tfa-settings')
  await box.getByRole('button', { name: T['set.2fa.enable'], exact: true }).click()
  const secret = (await page.getByTestId('tfa-secret').innerText()).replace(/\s+/g, '')
  const code = (offset: number) => totpCode(base32Decode(secret), Math.floor(Date.now() / 1000) + offset * 30)
  await box.getByLabel(T['acct.2fa.code']).fill(code(-1))
  await box.getByRole('button', { name: T['set.2fa.confirm'], exact: true }).click()
  await expect(box.getByText(T['set.2fa.on'], { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.locator('.whoami').click()
  await page.getByRole('menuitem', { name: T['acct.panel.logout'] }).click()
  await expect(page.getByRole('button', { name: T['acct.login.signIn'], exact: true })).toBeVisible()
  await signIn(page, server)
  await page.getByLabel(T['acct.2fa.code']).fill(code(0))
  await page.getByRole('button', { name: T['acct.2fa.verify'], exact: true }).click()
  await signedIn(page)
})

test.describe('passkey', () => {
  test.use({ publicHost: 'localhost' })
  test.skip(({ browserName }) => browserName !== 'chromium', 'sanal doğrulayıcı yalnız Chromium CDP ile')

  test('sanal doğrulayıcıyla ekleme ve giriş', async ({ page, server }) => {
    const cdp: CDPSession = await page.context().newCDPSession(page)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true }
    })
    await signIn(page, server)
    await signedIn(page)
    await openSettings(page)
    await page.locator('.settings-rail').getByText(T['set.sec.vault'], { exact: true }).click()
    const box = page.getByTestId('passkey-settings')
    await box.getByRole('button', { name: T['set.passkey.add'], exact: true }).click()
    await box.getByLabel(T['set.passkey.name'], { exact: true }).fill('Masaüstü')
    await box.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
    await box.getByRole('button', { name: T['set.passkey.continue'], exact: true }).click()
    await expect(box.getByText('Masaüstü', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.locator('.whoami').click()
    await page.getByRole('menuitem', { name: T['acct.panel.logout'] }).click()
    await page.getByRole('button', { name: T['acct.login.passkey'], exact: true }).click()
    await signedIn(page)
  })
})
