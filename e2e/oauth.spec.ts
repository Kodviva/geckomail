// Web OAuth uçtan uca: açılır pencere tıklamada açılır, yönlendirme adresi sunucunun /oauth/callback'i;
// sağlayıcıdan siteler arası dönüşte (SameSite=Strict oturum çerezi gelmez) akış uygulama sekmesinden
// tamamlanır (POST /oauth/complete) ve sonuç akışı başlatan oturuma 'oauth:done' ile ulaşır. Sağlayıcıya gerçek istek gitmez (sahte izin sayfası).
import type { Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import common from '../src/shared/i18n/locales/tr/common'
import set from '../src/shared/i18n/locales/tr/set'
import sync from '../src/shared/i18n/locales/tr/sync'

const T: Record<string, string> = { ...acct, ...common, ...set, ...sync }

async function signIn(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
}

test('OAuth penceresi tıklamada açılır; siteler arası dönüşten sonuç oturuma gelir', async ({ page, context, server }) => {
  server.setPref('oauth_google_client_id', 'e2e-istemci.apps.googleusercontent.com')
  // sahte izin sayfası: tarayıcı Google'a gitmez
  await context.route('https://accounts.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>Sahte izin</title><p>izin</p>' })
  )
  await signIn(page, server.url)
  // hesap yok: hesap ekleme sihirbazı açılır
  await page.getByPlaceholder(T['acct.import.emailPlaceholder']).fill('kisi@gmail.com')
  const connect = page.getByRole('button', { name: T['acct.import.connectWith'].replace('{provider}', 'Google'), exact: true })
  const [popup] = await Promise.all([page.waitForEvent('popup'), connect.click()])
  await popup.waitForURL(/^https:\/\/accounts\.google\.com\//)
  const u = new URL(popup.url())
  expect(u.searchParams.get('redirect_uri')).toBe(`${server.url}/oauth/callback`)
  expect(u.searchParams.get('code_challenge_method')).toBe('S256')
  const state = u.searchParams.get('state')!
  expect(Buffer.from(state, 'base64url')).toHaveLength(32)
  await expect(page.getByText(T['acct.import.oauthWaiting'].replace('{provider}', 'Google'))).toBeVisible()

  // Tasarım varsayımı bu tarayıcıda denenir (WebKit istek başlıklarında çerezi göstermez, sonuçtan okunur): sağlayıcı
  // sayfasından sunucuya üst düzey gezinme oturumsuz, uygulama sayfasının kendi isteği oturumlu
  const probe = await context.newPage()
  await probe.goto('https://accounts.google.com/deneme')
  await probe.evaluate((href) => {
    location.href = href
  }, `${server.url}/api/me`)
  await expect(probe.locator('body')).toContainText('unauthenticated')
  await probe.close()
  expect(await page.evaluate(async () => (await fetch('/api/me')).status)).toBe(200)

  // sağlayıcı izni reddetti: sağlayıcı sayfasından (siteler arası) sunucuya dönüş. Strict oturum çerezi gelmez;
  // tamamlama uygulama sekmesinden (POST /oauth/complete), sonuç 'oauth:done' ile
  const hits: { query: string; status: number }[] = []
  popup.on('response', (r) => {
    const ru = new URL(r.url())
    if (ru.pathname === '/oauth/callback') hits.push({ query: [...ru.searchParams.keys()].join(','), status: r.status() })
  })
  const completion = page.waitForResponse((r) => new URL(r.url()).pathname === '/oauth/complete')
  const closed = popup.waitForEvent('close')
  await popup.evaluate((href) => {
    location.href = href
  }, `${server.url}/oauth/callback?error=access_denied&state=${state}`)
  const c = await completion
  expect(c.status()).toBe(400)
  expect(await c.json()).toEqual({ reason: 'denied' })
  // dönüş sayfası tek istek; uygulama dönüşü görünce pencereyi kapatır
  await expect.poll(() => hits.length).toBe(1)
  expect(hits).toEqual([{ query: 'error,state', status: 200 }])
  // kapatma yok sayılsa da yinelenir (dönüş sayfası işlenmeden gelen kapatma, WebKit): pencere açık kalmaz
  await closed
  // sonuç akışı başlatan sekmeye: bekleme biter, hata iletisi görünür
  await expect(page.getByText(T['sync.oauth.denied'], { exact: true })).toBeVisible()
  await expect(page.getByText(T['acct.import.oauthWaiting'].replace('{provider}', 'Google'))).toHaveCount(0)
  // state tek kullanımlık
  const again = await page.request.get(`${server.url}/oauth/callback?error=access_denied&state=${state}`)
  expect(again.status()).toBe(400)
  expect(await again.text()).not.toMatch(/<script/i)
})

test('Ayarlar web yönlendirme adresini gösterir', async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { messages: [{ subject: 'Merhaba' }] }))
  await signIn(page, server.url)
  await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(T['set.sec.accounts'], { exact: true }).click()
  const box = page.locator('.oauth-clients')
  await box.getByRole('button', { name: T['action.edit'], exact: true }).click()
  await expect(box.getByLabel(T['set.oauth.redirectTitle'])).toHaveValue(`${server.url}/oauth/callback`)
  await expect(box.getByRole('button', { name: T['set.oauth.copy'], exact: true })).toBeVisible()
})
