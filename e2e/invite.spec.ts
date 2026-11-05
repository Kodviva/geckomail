// Toplantı daveti uçtan uca: kart görünür, kabul kuyruğa REPLY koyar, çift tık ikinci yanıt üretmez. Sahte iptal takvimi değiştirmez. Masaüstü ve 375×812.
import type { Page } from '@playwright/test'
import { ADMIN, expect, seedInvite, test, type GeckoServer } from './fixtures'
import acct from '../src/shared/i18n/locales/tr/acct'
import invite from '../src/shared/i18n/locales/tr/invite'

const ics = (method: string, ...more: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//t//t//EN', `METHOD:${method}`, 'BEGIN:VEVENT', 'UID:e2e-davet', 'DTSTAMP:20261101T000000Z', 'DTSTART:20371120T100000Z', 'DTEND:20371120T110000Z', 'SUMMARY:Bütçe toplantısı',
    'ORGANIZER;CN=Org:mailto:org@example.test', 'ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:deneme@example.test', ...more, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')

const replies = (server: GeckoServer): { meta: { ical: { method: string; content: string } }; draft: { to: string } }[] =>
  server.withDb((db) => (db.prepare(`SELECT payload_json FROM op_queue WHERE kind = 'smtp_send'`).all() as { payload_json: string }[]).map((r) => JSON.parse(r.payload_json)))

async function openMail(page: Page, url: string, subject: string): Promise<void> {
  await page.goto(url)
  await page.getByLabel(acct['acct.common.username'], { exact: true }).fill(ADMIN.username)
  await page.getByLabel(acct['acct.common.password'], { exact: true }).fill(ADMIN.password)
  await page.getByRole('button', { name: acct['acct.login.signIn'], exact: true }).click()
  await page.locator('.msg-row', { hasText: subject }).click()
}

for (const [label, size] of [['masaüstü', { width: 1280, height: 800 }], ['telefon', { width: 375, height: 812 }]] as const) {
  test.describe(label, () => {
    test.use({ viewport: size })

    test('davet kartı, kabul, kuyrukta REPLY', async ({ page, server }) => {
      const { subject } = seedInvite(server, ics('REQUEST'))
      await openMail(page, server.url, subject)
      const card = page.locator('.invite-card')
      await expect(card).toContainText('Bütçe toplantısı')
      await expect(card).toContainText('org@example.test')
      expect(replies(server)).toEqual([])
      expect(server.withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM calendar_objects`).get())).toEqual({ n: 0 })
      const accept = card.getByRole('button', { name: invite['invite.accept'], exact: true })
      if (size.width < 768) expect((await accept.boundingBox())!.width).toBeGreaterThan(280)
      await accept.dblclick()
      await expect(card).toContainText(invite['invite.answered.accepted'])
      const [reply, ...rest] = replies(server)
      expect(rest).toEqual([])
      expect(reply.draft.to).toBe('org@example.test')
      expect(reply.meta.ical.method).toBe('REPLY')
      expect(reply.meta.ical.content).toContain('PARTSTAT=ACCEPTED')
      expect(server.withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM calendar_objects`).get())).toEqual({ n: 1 })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    })

    test('gönderen düzenleyen değilse uyarı ve adres görünür', async ({ page, server }) => {
      const { subject } = seedInvite(server, ics('REQUEST'), 'baska@evil.test')
      await openMail(page, server.url, subject)
      await expect(page.locator('.invite-warn')).toContainText('org@example.test')
    })

    test('iptal kartında takvimde kopya yoksa eylem yok', async ({ page, server }) => {
      const { subject } = seedInvite(server, ics('CANCEL'))
      await openMail(page, server.url, subject)
      const card = page.locator('.invite-card')
      await expect(card).toContainText(invite['invite.kind.cancel'])
      await expect(card.getByRole('button')).toHaveCount(0)
    })
  })
}
