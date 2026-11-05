// Web girişi uçtan uca: parola, TOTP'li giriş (2FA Ayarlar'dan açılır), zorunlu kurulum (yönetici anahtarı)
// ve art arda hatalı denemede kilit. Kodlar sunucunun kullandığı totp modülüyle üretilir.
import type { Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import common from '../src/shared/i18n/locales/tr/common'
import set from '../src/shared/i18n/locales/tr/set'
import sync from '../src/shared/i18n/locales/tr/sync'
import { base32Decode, totpCode } from '../src/sync/auth/totp'

const T: Record<string, string> = { ...acct, ...common, ...set, ...sync }

/** offset adım (30 sn) kaydırılmış güncel kod; aynı adım ikinci kez kabul edilmediği için kurulumda -1 */
const codeAt = (secret: string, offset = 0): string =>
  totpCode(base32Decode(secret), Math.floor(Date.now() / 1000) + offset * 30)

async function fillCredentials(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(password)
}

/** Düğmeye basar ve verilen API yanıtını bekler (önceki denemenin iletisiyle karışmasın) */
async function clickAndWait(page: Page, button: string, path: string): Promise<number> {
  const [res] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === path),
    page.getByRole('button', { name: button, exact: true }).click()
  ])
  return res.status()
}

const signedInAs = (page: Page, username: string) => expect(page.locator('.whoami-name')).toHaveText(username)

async function openSecuritySettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
  // geniş ekranda bölümler soldaki rayda (dar ekranda üstteki çiplerde)
  await page.locator('.settings-rail').getByText(T['set.sec.vault'], { exact: true }).click()
  await expect(page.getByTestId('tfa-settings')).toBeVisible()
}

async function logout(page: Page): Promise<void> {
  await page.locator('.whoami').click()
  await page.getByRole('menuitem', { name: T['acct.panel.logout'] }).click()
  await expect(page.getByRole('button', { name: T['acct.login.signIn'], exact: true })).toBeVisible()
}

/** Kurulum ekranındaki (giriş ya da Ayarlar) QR ve elle girilecek sır */
async function readSetup(page: Page): Promise<string> {
  const qr = page.getByRole('img', { name: T['acct.2fa.qrAlt'] })
  await expect(qr).toBeVisible()
  expect(await qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/)
  const secret = (await page.getByTestId('tfa-secret').innerText()).replace(/\s+/g, '')
  expect(secret).toMatch(/^[A-Z2-7]{32}$/)
  return secret
}

test('parolayla giriş; hatalı parola iletisi; oturum yalnız HttpOnly çerezde', async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { messages: [{ subject: 'E2E merhaba' }] }))
  await page.goto(server.url)

  await fillCredentials(page, ADMIN.username, 'yanlis-parola')
  expect(await clickAndWait(page, T['acct.login.signIn'], '/api/login')).toBe(401)
  await expect(page.locator('.auth-error')).toHaveText(T['sync.auth.badCredentials'])

  await fillCredentials(page, ADMIN.username, ADMIN.password)
  expect(await clickAndWait(page, T['acct.login.signIn'], '/api/login')).toBe(200)
  await signedInAs(page, ADMIN.username)
  await expect(page.getByText('E2E merhaba')).toBeVisible()

  const cookie = (await page.context().cookies()).find((c) => c.name === 'gm_session')
  expect(cookie?.httpOnly).toBe(true)
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }))
  expect(stored).not.toContain(ADMIN.password)
})

test('2FA Ayarlar\'dan açılır; sonraki girişte kod istenir; kodla kapatılınca oturumlar kapanır', async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { messages: [{ subject: 'E2E kod' }] }))
  await page.goto(server.url)
  await fillCredentials(page, ADMIN.username, ADMIN.password)
  await clickAndWait(page, T['acct.login.signIn'], '/api/login')
  await signedInAs(page, ADMIN.username)

  await openSecuritySettings(page)
  const tfa = page.getByTestId('tfa-settings')
  await expect(tfa.getByText(T['set.2fa.off'], { exact: true })).toBeVisible()
  await tfa.getByRole('button', { name: T['set.2fa.enable'], exact: true }).click()
  const secret = await readSetup(page)
  await tfa.getByLabel(T['acct.2fa.code']).fill(codeAt(secret, -1))
  await tfa.getByRole('button', { name: T['set.2fa.confirm'], exact: true }).click()
  await expect(tfa.getByText(T['set.2fa.on'], { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await logout(page)

  await fillCredentials(page, ADMIN.username, ADMIN.password)
  expect(await clickAndWait(page, T['acct.login.signIn'], '/api/login')).toBe(428)
  await expect(page.getByText(T['acct.2fa.title'], { exact: true })).toBeVisible()
  const code = page.getByLabel(T['acct.2fa.code'])

  const wrong = codeAt(secret, 0) === '000000' ? '111111' : '000000'
  await code.fill(wrong)
  expect(await clickAndWait(page, T['acct.2fa.verify'], '/api/login')).toBe(401)
  await expect(page.locator('.auth-error')).toHaveText(T['acct.2fa.badCode'])

  await code.fill(codeAt(secret, 0))
  expect(await clickAndWait(page, T['acct.2fa.verify'], '/api/login')).toBe(200)
  await signedInAs(page, ADMIN.username)
  await expect(page.getByText('E2E kod')).toBeVisible()

  // kapatma: kod istenir; sunucu bütün oturumları kapatır → giriş ekranı ve 2FA bildirimi
  await openSecuritySettings(page)
  await tfa.getByRole('button', { name: T['set.2fa.disable'], exact: true }).click()
  await tfa.getByLabel(T['acct.2fa.code']).fill(codeAt(secret, 1)) // girişte kullanılan adım yeniden kabul edilmez
  await tfa.getByRole('button', { name: T['set.2fa.disable'], exact: true }).click()
  await expect(page.getByRole('button', { name: T['acct.login.signIn'], exact: true })).toBeVisible()
  await expect(page.getByText(T['set.2fa.disabledRelogin'])).toBeVisible()
  await expect(page.getByText(T['acct.session.expired'])).toHaveCount(0)
  await fillCredentials(page, ADMIN.username, ADMIN.password)
  expect(await clickAndWait(page, T['acct.login.signIn'], '/api/login')).toBe(200)
  await signedInAs(page, ADMIN.username)
})

test('yönetici 2FA\'yı zorunlu tutunca 2FA\'sız kullanıcı girişte QR ile kurar', async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { messages: [{ subject: 'E2E zorunlu' }] }))
  await server.createUser('ayse', 'ayse-parola-12')

  // yönetici anahtarı Ayarlar'dan
  await page.goto(server.url)
  await fillCredentials(page, ADMIN.username, ADMIN.password)
  await clickAndWait(page, T['acct.login.signIn'], '/api/login')
  await signedInAs(page, ADMIN.username)
  await openSecuritySettings(page)
  const requireBox = page.getByRole('checkbox', { name: T['set.2fa.require'] })
  await requireBox.check()
  await expect(requireBox).toBeChecked()
  await expect.poll(() => server.withDb((db) => (db.prepare(`SELECT value FROM prefs WHERE key = 'require2fa'`).get() as { value: string } | undefined)?.value)).toBe('1')
  await page.keyboard.press('Escape')
  await logout(page)

  await fillCredentials(page, 'ayse', 'ayse-parola-12')
  await clickAndWait(page, T['acct.login.signIn'], '/api/2fa/setup/begin')
  await expect(page.getByText(T['acct.2fa.setupTitle'], { exact: true })).toBeVisible()
  const secret = await readSetup(page)
  await page.getByLabel(T['acct.2fa.code']).fill(codeAt(secret, 0))
  expect(await clickAndWait(page, T['acct.2fa.verify'], '/api/2fa/setup/confirm')).toBe(200)
  await signedInAs(page, 'ayse')
  await expect(page.getByText('E2E zorunlu')).toBeVisible()

  // zorunluyken kapatılamaz
  await openSecuritySettings(page)
  const tfa = page.getByTestId('tfa-settings')
  await expect(tfa.getByText(T['set.2fa.on'], { exact: true })).toBeVisible()
  await expect(tfa.getByRole('button', { name: T['set.2fa.disable'], exact: true })).toBeDisabled()
  await expect(tfa.getByText(T['set.2fa.requiredNote'])).toBeVisible()
})

test('art arda hatalı parolada kilit iletisi; doğru parola da kilitte reddedilir', async ({ page, server }) => {
  await page.goto(server.url)
  await fillCredentials(page, ADMIN.username, 'yanlis-parola')
  for (let i = 0; i < 5; i++) {
    expect(await clickAndWait(page, T['acct.login.signIn'], '/api/login')).toBe(401)
    await expect(page.locator('.auth-error')).toHaveText(T['sync.auth.badCredentials'])
  }
  await fillCredentials(page, ADMIN.username, ADMIN.password)
  expect(await clickAndWait(page, T['acct.login.signIn'], '/api/login')).toBe(423)
  await expect(page.locator('.auth-error')).toHaveText(T['acct.login.webLocked'])
  await expect(page.locator('.whoami-name')).toHaveCount(0)
})
