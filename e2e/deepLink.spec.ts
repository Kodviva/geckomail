// Bildirimden gelen adres: pencere yokken service worker /?m=<id> ya da /?reply=<id> açar. Giriş ekranından sonra da
// geçerlidir, işlendikten sonra adres temizlenir (yenileme yinelemesin).
import type { Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'

async function signIn(page: Page): Promise<void> {
  await page.getByLabel(acct['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(acct['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
}

const seed = (server: GeckoServer): number =>
  server.withDb((db) => {
    const { messageIds } = seedMail(db, { messages: [{ subject: 'Bildirimli ileti' }, { subject: 'Başka ileti', seen: true }] })
    db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, 'Gövde', NULL, ?, ?, 5)`)
      .run(messageIds[0], Date.now(), Date.now())
    return messageIds[0]
  })

test('/?m=: girişten sonra ileti açılır, adres temizlenir', async ({ page, server }) => {
  const messageId = seed(server)
  await page.goto(`${server.url}/?m=${messageId}`)
  await signIn(page)
  await expect(page.getByText('Gövde', { exact: true })).toBeVisible()
  expect(new URL(page.url()).search).toBe('')
})

test('reply opens composer: /?reply= yanıt penceresini açar', async ({ page, server }) => {
  const messageId = seed(server)
  await page.goto(`${server.url}/?reply=${messageId}`)
  await signIn(page)
  await expect(page.locator('.subject-row input')).toHaveValue('Re: Bildirimli ileti')
  expect(new URL(page.url()).search).toBe('')
})

test('açık oturumda /?m=: giriş istenmez', async ({ page, server }) => {
  const messageId = seed(server)
  await page.goto(server.url)
  await signIn(page)
  await page.goto(`${server.url}/?m=${messageId}`)
  await expect(page.getByText('Gövde', { exact: true })).toBeVisible()
})
