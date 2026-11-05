// Passkey uçtan uca: Chromium'un CDP sanal doğrulayıcısıyla gerçek navigator.credentials çağrıları. Firefox ve
// WebKit'te Playwright'tan erişilebilen eşdeğer sanal doğrulayıcı yok (WebAuthn CDP etki alanı yalnız Chromium'da);
// sunucu doğrulaması birim testlerinde motorsuz sınanır. WebAuthn IP'yi RP ID kabul etmez: köken localhost.
import type { CDPSession, Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import common from '../src/shared/i18n/locales/tr/common'
import set from '../src/shared/i18n/locales/tr/set'

const T: Record<string, string> = { ...acct, ...common, ...set }
const PASSKEY = T['acct.login.passkey']

test.use({ publicHost: 'localhost' })

async function signIn(page: Page, server: GeckoServer): Promise<void> {
  // hesap varken ilk açılışta içe aktarma sihirbazı çıkmaz
  server.withDb((db) => seedMail(db, { messages: [{ subject: 'Merhaba' }] }))
  await page.goto(server.url)
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
}

async function openSecurity(page: Page): Promise<void> {
  await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(T['set.sec.vault'], { exact: true }).click()
  await expect(page.getByTestId('passkey-settings')).toBeVisible()
}

async function addPasskey(page: Page, name: string): Promise<void> {
  const box = page.getByTestId('passkey-settings')
  await box.getByRole('button', { name: T['set.passkey.add'], exact: true }).click()
  await box.getByLabel(T['set.passkey.name'], { exact: true }).fill(name)
  await box.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await box.getByRole('button', { name: T['set.passkey.continue'], exact: true }).click()
  await expect(box.getByText(name, { exact: true })).toBeVisible()
}

async function logout(page: Page): Promise<void> {
  await page.keyboard.press('Escape') // ayarlar paneli
  await page.locator('.whoami').click()
  await page.getByRole('menuitem', { name: T['acct.panel.logout'] }).click()
  await expect(page.getByRole('button', { name: PASSKEY, exact: true })).toBeVisible()
}

/** Her testte taze, ortak olmayan doğrulayıcı: kullanıcı doğrulaması otomatik geçer */
async function virtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
      automaticPresenceSimulation: true
    }
  })
  return { cdp, authenticatorId }
}

test('tarayıcı passkey desteklemiyorsa düğme gizli', async ({ page, server }) => {
  await page.addInitScript(() => {
    delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential
  })
  await page.goto(server.url)
  await expect(page.getByRole('button', { name: T['acct.login.signIn'], exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: PASSKEY, exact: true })).toHaveCount(0)
})

test.describe('IP kökeni', () => {
  test.use({ publicHost: '127.0.0.1' })

  test('WebAuthn IP ile çalışmaz: düğme gizli, sunucu başlangıçta bildirir', async ({ page, server }) => {
    await page.goto(server.url)
    await expect(page.getByRole('button', { name: T['acct.login.signIn'], exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: PASSKEY, exact: true })).toHaveCount(0)
    expect(server.logs()).toMatch(/passkey kullanılamaz/)
  })
})

test('yeniden doğrulama: yanlış parola eklemeyi durdurur, form açık kalır', async ({ page, server }) => {
  await signIn(page, server)
  await openSecurity(page)
  const box = page.getByTestId('passkey-settings')
  await box.getByRole('button', { name: T['set.passkey.add'], exact: true }).click()
  await box.getByLabel(T['set.passkey.name'], { exact: true }).fill('Telefon')
  await box.getByLabel(T['acct.common.password'], { exact: true }).fill('yanlis-parola')
  await box.getByRole('button', { name: T['set.passkey.continue'], exact: true }).click()
  await expect(box.getByRole('alert')).toHaveText(T['set.passkey.reauthBad'])
  await expect(box.getByLabel(T['acct.common.password'], { exact: true })).toHaveValue('')
  expect(server.withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM passkeys`).get())).toEqual({ n: 0 })
})

test.describe('sanal doğrulayıcı', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'sanal doğrulayıcı yalnız Chromium CDP ile')

  test('ayarlardan eklenir, kullanıcı adı ve parola olmadan girer, zorunlu 2FA\'yı karşılar, silinince geçmez', async ({ page, server }) => {
    await virtualAuthenticator(page)
    await signIn(page, server)
    await openSecurity(page)
    await addPasskey(page, 'Dizüstü')
    await expect(page.getByTestId('passkey-settings').getByText(`${T['set.passkey.neverUsed']}`, { exact: false })).toBeVisible()
    const row = server.withDb((db) => db.prepare(`SELECT name, last_used_at FROM passkeys`).all())
    expect(row).toEqual([{ name: 'Dizüstü', last_used_at: null }])

    await logout(page)
    // kullanıcı adı ve parola boş: yalnız düğme
    server.setPref('require2fa', '1')
    await page.getByRole('button', { name: PASSKEY, exact: true }).click()
    await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
    server.setPref('require2fa', '0')
    const used = server.withDb((db) => db.prepare(`SELECT last_used_at FROM passkeys`).get()) as { last_used_at: number | null }
    expect(used.last_used_at).not.toBeNull()

    // yenilemede oturum çerezle sürer
    await page.reload()
    await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)

    await openSecurity(page)
    page.once('dialog', (d) => void d.accept())
    const box = page.getByTestId('passkey-settings')
    await box.getByRole('button', { name: `${T['action.delete']}: Dizüstü`, exact: true }).click()
    await expect(box.getByText(T['set.passkey.none'], { exact: false })).toBeVisible()
    await logout(page)
    // doğrulayıcıda anahtar duruyor ama sunucuda yok
    await page.getByRole('button', { name: PASSKEY, exact: true }).click()
    await expect(page.locator('.auth-error')).toHaveText(T['acct.login.passkeyFailed'])
  })

  test('devre dışı kullanıcı passkey ile giremez; aynı anahtar ikinci kez eklenmez', async ({ page, server }) => {
    await virtualAuthenticator(page)
    await signIn(page, server)
    await openSecurity(page)
    await addPasskey(page, 'Birinci')
    // excludeCredentials: doğrulayıcı aynı kullanıcıya ikinci anahtar üretmez
    const box = page.getByTestId('passkey-settings')
    await box.getByRole('button', { name: T['set.passkey.add'], exact: true }).click()
    await box.getByLabel(T['set.passkey.name'], { exact: true }).fill('İkinci')
    await box.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
    await box.getByRole('button', { name: T['set.passkey.continue'], exact: true }).click()
    await expect(page.getByText(T['set.passkey.duplicate'], { exact: true })).toBeVisible()
    expect(server.withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM passkeys`).get())).toEqual({ n: 1 })
    await box.getByRole('button', { name: T['action.cancel'], exact: true }).click()

    await logout(page)
    server.withDb((db) => db.prepare(`UPDATE users SET enabled = 0`).run())
    await page.getByRole('button', { name: PASSKEY, exact: true }).click()
    await expect(page.locator('.auth-error')).toHaveText(T['acct.login.passkeyFailed'])
    await expect(page.locator('.whoami-name')).toHaveCount(0)
  })

  test('kullanıcı doğrulaması başarısızsa giriş olmaz ve hata gösterilmez (istem iptali)', async ({ page, server }) => {
    const { cdp, authenticatorId } = await virtualAuthenticator(page)
    await signIn(page, server)
    await openSecurity(page)
    await addPasskey(page, 'Telefon')
    await logout(page)
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false })
    const verify = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/passkey/login/options')
    await page.getByRole('button', { name: PASSKEY, exact: true }).click()
    await verify
    // doğrulayıcı reddi tarayıcıda NotAllowedError: sunucuya hiç gitmez, düğme yeniden etkin
    await expect(page.getByRole('button', { name: PASSKEY, exact: true })).toBeEnabled()
    await expect(page.locator('.auth-error')).toHaveCount(0)
    await expect(page.locator('.whoami-name')).toHaveCount(0)
  })
})
