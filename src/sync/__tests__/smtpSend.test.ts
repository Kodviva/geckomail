import PostalMime from 'postal-mime'
import { describe, expect, it } from 'vitest'
import type { AccountRow } from '../db/queries'
import { composeRaw, newMessageId } from '../smtpSend'

const acc = { email: 'a@t.co', display_name: null } as AccountRow
const draft = { accountId: 1, to: 'o@x.co', subject: 'Kabul edildi', text: 'Yanıt', inReplyTo: '<o@x.co>' }
const content = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REPLY', 'BEGIN:VEVENT', 'UID:u1', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')

describe('composeRaw', () => {
  it('reply has text/calendar method=REPLY alternative', async () => {
    const raw = await composeRaw(acc, draft, [], { messageId: newMessageId(acc.email), date: 1_700_000_000_000, ical: { method: 'REPLY', content } })
    const text = raw.toString()
    expect(text).toMatch(/Content-Type: multipart\/alternative/i)
    expect(text).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REPLY/i)
    const parsed = await PostalMime.parse(raw)
    expect(parsed.text?.trim()).toBe('Yanıt')
    expect(parsed.attachments.some((a) => a.mimeType === 'text/calendar')).toBe(true)
  })
  it('normal mail has no calendar part', async () => {
    const raw = await composeRaw(acc, draft, [], { messageId: newMessageId(acc.email), date: 1 })
    expect(raw.toString()).not.toMatch(/text\/calendar/i)
  })
})
