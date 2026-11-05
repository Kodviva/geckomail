// Ayarlar › Bildirimler: kural oluştur / sırala / sil, hesap kapat (yenilemede kalıcı), kayıtlı cihaz kaldır.
import type { Page } from '@playwright/test'
import { ADMIN, expect, seedMail, test } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import set from '../src/shared/i18n/locales/tr/set'
import common from '../src/shared/i18n/locales/tr/common'

const T: Record<string, string> = { ...acct, ...set, ...common }

async function signIn(page: Page): Promise<void> {
  await page.getByLabel(T['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(T['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: T['acct.login.signIn'], exact: true }).click()
  await expect(page.locator('.whoami-name')).toHaveText(ADMIN.username)
}

async function openNotify(page: Page): Promise<void> {
  await page.getByRole('button', { name: T['acct.common.settings'], exact: true }).click()
  await page.locator('.settings-rail').getByText(T['set.sec.notify'], { exact: true }).click()
}

/** Belirtilen RPC yöntemine tarayıcı tarafında hata yanıtı döndürür (WebSocket aracılığıyla), diğerlerini sunucuya iletir */
async function failRpc(page: Page, method: string): Promise<void> {
  await page.routeWebSocket(/\/rpc/, (ws) => {
    const server = ws.connectToServer()
    server.onMessage((m) => ws.send(m))
    ws.onMessage((m) => {
      try {
        const req = JSON.parse(String(m)) as { id?: number; method?: string }
        if (req.method === method && typeof req.id === 'number') {
          ws.send(JSON.stringify({ id: req.id, ok: false, error: 'e2e' }))
          return
        }
      } catch { /* iletilir */ }
      server.send(m)
    })
  })
}

async function addRule(page: Page, name: string, value: string, level: string): Promise<void> {
  await page.getByRole('button', { name: T['set.nr.add'], exact: true }).click()
  const ed = page.getByTestId('notify-rule-editor')
  await ed.getByLabel(T['set.nr.name'], { exact: true }).fill(name)
  await ed.getByLabel(T['set.nr.value'], { exact: true }).fill(value)
  await ed.getByRole('combobox').last().selectOption(level)
  await ed.getByRole('button', { name: T['action.save'], exact: true }).click()
  await expect(page.getByTestId('notify-rule').filter({ hasText: name })).toBeVisible()
}

test('kural oluştur, sırala, sil', async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
  await page.goto(server.url)
  await signIn(page)
  await openNotify(page)

  await addRule(page, 'Patron', 'x@example.test', 'urgent')
  await addRule(page, 'Bülten', 'bulten@example.test', 'silent')
  const rows = page.getByTestId('notify-rule')
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText('Patron')

  await page.getByRole('button', { name: `${T['set.nr.down']}: Patron`, exact: true }).click()
  await expect(rows.nth(0)).toContainText('Bülten')
  await page.reload()
  await openNotify(page)
  await expect(rows.nth(0)).toContainText('Bülten')
  await expect(rows.nth(1)).toContainText('Patron')

  // geçersiz form: dolu koşul yok
  await page.getByRole('button', { name: T['set.nr.add'], exact: true }).click()
  const ed = page.getByTestId('notify-rule-editor')
  await ed.getByLabel(T['set.nr.name'], { exact: true }).fill('Boş')
  await ed.getByRole('button', { name: T['action.save'], exact: true }).click()
  await expect(ed.getByRole('alert')).toHaveText(T['set.nr.err.groups'])
  await ed.getByRole('button', { name: T['action.cancel'], exact: true }).click()

  page.once('dialog', (d) => void d.accept())
  await page.getByRole('button', { name: `${T['action.delete']}: Patron`, exact: true }).click()
  await expect(rows).toHaveCount(1)
  await expect(rows.nth(0)).toContainText('Bülten')
})

test('hesap bildirimi kapatılır ve yenilemede kalıcıdır', async ({ page, server }) => {
  server.withDb((db) => {
    seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] })
    seedMail(db, { email: 'b@example.test', messages: [{ subject: 'B' }] })
  })
  await page.goto(server.url)
  await signIn(page)
  await openNotify(page)

  const box = (email: string) => page.getByLabel(T['set.na.toggle'].replace('{email}', email), { exact: true })
  await expect(box('a@example.test')).toBeChecked()
  await box('a@example.test').uncheck()
  await page.getByLabel(T['set.na.search'], { exact: true }).fill('b@')
  await expect(box('a@example.test')).toHaveCount(0)
  await page.reload()
  await openNotify(page)
  await expect(box('a@example.test')).not.toBeChecked()
  await expect(box('b@example.test')).toBeChecked()
})

test('kayıtlı cihaz listelenir ve kaldırılır', async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
  await page.goto(server.url)
  await signIn(page)
  server.withDb((db) => {
    const uid = (db.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: number }).id
    db.prepare(`INSERT INTO push_devices (user_id, web_session_id, endpoint, p256dh, auth, label, created_at) VALUES (?, NULL, ?, 'k', 'a', 'Test telefonu', ?)`)
      .run(uid, 'https://fcm.googleapis.com/fcm/send/e2e', Date.now())
  })
  await openNotify(page)
  const dev = page.getByTestId('notify-devices')
  await expect(dev).toContainText('Test telefonu')
  page.once('dialog', (d) => void d.accept())
  await dev.getByRole('button', { name: `${T['set.nd.remove']}: Test telefonu`, exact: true }).click()
  await expect(dev).not.toContainText('Test telefonu')
  await expect(dev).toContainText(T['set.nd.none'])
})

test('kural kaydı RPC hatasıyla düşerse düzenleyicide hata görünür', async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
  await failRpc(page, 'saveNotifyRule')
  await page.goto(server.url)
  await signIn(page)
  await openNotify(page)
  await page.getByRole('button', { name: T['set.nr.add'], exact: true }).click()
  const ed = page.getByTestId('notify-rule-editor')
  await ed.getByLabel(T['set.nr.name'], { exact: true }).fill('Düşen')
  await ed.getByLabel(T['set.nr.value'], { exact: true }).fill('x@example.test')
  await ed.getByRole('button', { name: T['action.save'], exact: true }).click()
  await expect(ed.getByRole('alert')).toHaveText(T['set.nr.saveFailed'])
  await expect(page.getByTestId('notify-rule')).toHaveCount(0)
})

test('hesap bildirimi RPC hatasıyla düşerse kutu geri alınır ve hata bildirilir', async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
  await failRpc(page, 'setNotifyAccountPref')
  await page.goto(server.url)
  await signIn(page)
  await openNotify(page)
  const box = page.getByLabel(T['set.na.toggle'].replace('{email}', 'a@example.test'), { exact: true })
  await expect(box).toBeChecked()
  await box.click()
  await expect(page.getByRole('status').filter({ hasText: T['set.nr.saveFailed'] })).toBeVisible()
  await expect(box).toBeChecked()
  await expect(box).toBeEnabled()
})

test('bu oturumun cihazı "bu cihaz" olarak işaretlenir; etiketsiz cihazda ad yerine çizgi', async ({ page, server }) => {
  server.withDb((db) => seedMail(db, { email: 'a@example.test', messages: [{ subject: 'A' }] }))
  await page.goto(server.url)
  await signIn(page)
  server.withDb((db) => {
    const s = db.prepare(`SELECT id_hash, user_id FROM web_sessions ORDER BY created_at DESC LIMIT 1`).get() as { id_hash: string; user_id: number }
    const ins = db.prepare(`INSERT INTO push_devices (user_id, web_session_id, endpoint, p256dh, auth, label, created_at) VALUES (?, ?, ?, 'k', 'a', ?, ?)`)
    ins.run(s.user_id, s.id_hash, 'https://fcm.googleapis.com/fcm/send/e2e-cur', 'Bu tarayıcı', Date.now())
    ins.run(s.user_id, null, 'https://fcm.googleapis.com/fcm/send/e2e-bos', '', Date.now())
  })
  await openNotify(page)
  const dev = page.getByTestId('notify-devices')
  await expect(dev.locator('.set-field').filter({ hasText: 'Bu tarayıcı' })).toContainText(T['set.nd.current'])
  await expect(dev.getByRole('button', { name: `${T['set.nd.remove']}: —`, exact: true })).toBeVisible()
})
