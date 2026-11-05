// README görselleri: yalnız sahte veri (example.test). `README_SHOTS=1 npx playwright test readme-shots --project=chromium`
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN, expect, seedMail, test } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'

const OUT = join(__dirname, '..', 'docs', 'img')

test.skip(!process.env.README_SHOTS, 'yalnız elle')

test('README görselleri', async ({ page, server }) => {
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 1360, height: 860 })
  const subjects = ['Haftalık rapor hazır', 'Sunucu bakımı Cuma 22:00', 'Fatura 2026-114', 'Toplantı notları', 'Yeni kullanıcı talebi', 'Yedekleme tamamlandı']
  server.withDb((db) => {
    const { messageIds } = seedMail(db, { messages: subjects.map((subject) => ({ subject })) })
    db.prepare(`INSERT INTO bodies (message_id, text_plain, html, fetched_at, last_access_at, raw_size) VALUES (?, ?, ?, ?, ?, ?)`).run(
      messageIds[0], 'Merhaba, bu haftanın raporu ektedir.', '<p>Merhaba,</p><p>Bu haftanın raporu ektedir.</p><p>Demo Ekibi</p>', Date.now(), Date.now(), 100
    )
  })
  await page.goto(server.url)
  await page.screenshot({ path: join(OUT, 'giris.png') })
  await page.getByLabel(acct['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(acct['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
  await expect(page.getByText(subjects[0]).first()).toBeVisible()
  await page.screenshot({ path: join(OUT, 'gelen-kutusu.png') })
  await page.getByText(subjects[0]).first().click()
  await expect(page.locator('iframe.mail-frame')).toBeVisible()
  await page.screenshot({ path: join(OUT, 'ileti.png') })
})
