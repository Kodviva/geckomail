// Posta ekleri uçtan uca: ek arayüzden HTTP akışıyla iner (WebSocket'e girmez); görme yetkisi olmayan üye
// eki doğrudan istese de 403 alır.
import type { Page } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { ADMIN, expect, seedAttachment, seedMail, test } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import { hashPassword } from '../src/sync/auth/password'

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

async function signIn(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.getByLabel(acct['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(acct['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
}

test('HTML ileti listede görünür, açılır; gövde sandbox iframe içinde, betik çalışmaz', async ({ page, server }) => {
  server.withDb((db) => {
    const { messageIds } = seedMail(db, { messages: [{ subject: 'E2E HTML ileti' }] })
    db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, ?, ?, ?, ?, ?)`).run(
      messageIds[0], 'düz metin', '<p id="govde">HTML gövdesi</p><script>document.title = "ele-gecirildi"</script>', Date.now(), Date.now(), 100
    )
  })
  await signIn(page, server.url)
  await page.getByText('E2E HTML ileti').click()
  const frame = page.locator('iframe.mail-frame')
  await expect(frame).toBeVisible()
  await expect(frame).toHaveAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox')
  const sandbox = (await frame.getAttribute('sandbox'))!.split(/\s+/)
  expect(sandbox).not.toContain('allow-same-origin')
  expect(sandbox).not.toContain('allow-scripts')
  await expect(page.frameLocator('iframe.mail-frame').getByText('HTML gövdesi')).toBeVisible()
  expect(await frame.getAttribute('srcdoc')).not.toMatch(/<script/i)
})

test('ek arayüzden HTTP ile indirilir (8 MB üstü)', async ({ page, server }) => {
  const content = randomBytes(9 * 1024 * 1024)
  const name = 'Şubat raporu.pdf'
  seedAttachment(server, name, content)
  await signIn(page, server.url)

  // WebSocket çerçevelerinde ek içeriği taşınmamalı
  let wsBytes = 0
  page.on('websocket', (ws) => ws.on('framereceived', (f) => (wsBytes += String(f.payload).length)))

  await page.getByText('E2E ekli ileti').click()
  const chip = page.locator('.att-name', { hasText: name })
  await expect(chip).toBeVisible()
  const [download] = await Promise.all([page.waitForEvent('download'), chip.click()])
  // WebKit önerilen adı değiştirir (macOS NFD'ye çevirir, Linux boşluğu _ yapar); ad sunucudan doğru çıkmıştır
  expect(download.suggestedFilename().normalize('NFC').replace(/_/g, ' ')).toBe(name)
  const saved = await download.path()
  expect(sha256(readFileSync(saved))).toBe(sha256(content))
  expect(wsBytes).toBeLessThan(1024 * 1024)
})

test('görme yetkisi olmayan üye eki indiremez (403)', async ({ request, server }) => {
  const { messageId, attachmentId } = seedAttachment(server, 'gizli.pdf', Buffer.from('gizli içerik'))
  // grubu olmayan hesap: yalnız yönetici görür. Üye doğrudan DB'ye (CLI yalnız yönetici açar)
  server.withDb((db) =>
    db.prepare(`INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, 'member', ?)`).run('uye', hashPassword('uye-parola-123'), Date.now())
  )
  const login = await request.post(`${server.url}/api/login`, {
    headers: { origin: server.url }, data: { username: 'uye', password: 'uye-parola-123' }
  })
  expect(login.status()).toBe(200)
  // istek bağlamının kavanozuna güvenilmez: sorunun hangi oturumla sorulduğu belli olsun diye çerez başlığı elle
  const cookie = (login.headers()['set-cookie'] ?? '').split(';')[0]
  expect(cookie).toMatch(/^gm_session=/)
  const r = await request.get(`${server.url}/api/attachment/${messageId}/${attachmentId}`, { headers: { cookie } })
  expect(r.status()).toBe(403)
  expect(await r.text()).not.toContain('gizli içerik')
  // çerezsiz: 401
  const anon = await request.get(`${server.url}/api/attachment/${messageId}/${attachmentId}`, { headers: { cookie: '' } })
  expect(anon.status()).toBe(401)
})
