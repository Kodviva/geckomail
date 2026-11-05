import { describe, expect, it } from 'vitest'
import { toNotificationLink } from '../nativeLinks'

describe('toNotificationLink', () => {
  it('geçerli bağlantı aynen döner', () => {
    expect(toNotificationLink({ messageId: 42, accountId: 3, reply: true })).toEqual({ messageId: 42, accountId: 3, reply: true })
    expect(toNotificationLink({ messageId: null, accountId: 3, reply: false })).toEqual({ messageId: null, accountId: 3, reply: false })
  })

  it('tamsayı olmayan kimliği düşürür', () => {
    for (const messageId of ['42', 1.5, -1, 0, NaN, Infinity, 2 ** 60, {}, '../x']) {
      expect(toNotificationLink({ messageId, accountId: null, reply: false } as never), String(messageId)).toBeNull()
    }
    expect(toNotificationLink({ messageId: 42, accountId: '3', reply: false } as never)).toEqual({ messageId: 42, accountId: null, reply: false })
  })

  it('iki kimlik de yoksa null, reply yalnız true ise', () => {
    expect(toNotificationLink({ messageId: null, accountId: null, reply: true })).toBeNull()
    expect(toNotificationLink({ messageId: 1, accountId: null, reply: 'true' } as never)).toEqual({ messageId: 1, accountId: null, reply: false })
  })

  it('bozuk girdi', () => {
    for (const v of [null, undefined, 5, 'x', []]) expect(toNotificationLink(v as never)).toBeNull()
  })
})
