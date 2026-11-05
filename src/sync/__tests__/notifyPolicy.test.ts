import { describe, expect, it } from 'vitest'
import { inQuietHours, isVip, parseNotifyPrefs, parseVipList, shouldNotifyMessage, shouldNotifySummary } from '../notifyPolicy'

const at = (h: number, m = 0) => new Date(2026, 8, 30, h, m)

describe('bildirim politikası (R31)', () => {
  it('sessiz saat: gece yarısını aşan ve aşmayan aralık', () => {
    expect(inQuietHours(at(23), '22:00', '08:00')).toBe(true)
    expect(inQuietHours(at(7, 59), '22:00', '08:00')).toBe(true)
    expect(inQuietHours(at(8), '22:00', '08:00')).toBe(false)
    expect(inQuietHours(at(13), '12:00', '14:00')).toBe(true)
    expect(inQuietHours(at(14), '12:00', '14:00')).toBe(false)
    expect(inQuietHours(at(3), null, '08:00')).toBe(false)
  })
  it('VIP listesi: adres ve alan, alt alan; geçersizler atılır', () => {
    const vip = parseVipList('Ali@X.co, @firma.co; bozuk  x@y.co\n@')
    expect(vip).toEqual(['ali@x.co', '@firma.co', 'x@y.co'])
    expect(isVip('ALI@x.co', vip)).toBe(true)
    expect(isVip('muhasebe@firma.co', vip)).toBe(true)
    expect(isVip('a@mail.firma.co', vip)).toBe(true)
    expect(isVip('a@kotufirma.co', vip)).toBe(false)
    expect(isVip(null, vip)).toBe(false)
  })
  it('tercihler: sessiz saat kapalıysa saatler yok sayılır; geçersiz saat reddedilir', () => {
    const prefs = { notifyScope: 'all', notifyQuiet: '0', notifyQuietStart: '22:00', notifyQuietEnd: '08:00' } as Record<string, string>
    expect(parseNotifyPrefs((k) => prefs[k]).quietStart).toBeNull()
    prefs.notifyQuiet = '1'
    prefs.notifyQuietEnd = '25:00'
    const p = parseNotifyPrefs((k) => prefs[k])
    expect([p.quietStart, p.quietEnd, p.scope]).toEqual(['22:00', null, 'all'])
  })
  it('karar: VIP ve acil kural sessiz saati/susturmayı aşar; özet kapsama uyar', () => {
    const p = { scope: 'starred' as const, mutedUntil: 0, quietStart: '22:00', quietEnd: '08:00', vip: [] }
    expect(shouldNotifyMessage(p, 'vip', at(23))).toBe(true)
    expect(shouldNotifyMessage(p, 'rule-urgent', at(23))).toBe(true)
    expect(shouldNotifyMessage(p, 'rule', at(23))).toBe(false)
    expect(shouldNotifyMessage(p, 'rule', at(10))).toBe(true)
    expect(shouldNotifyMessage({ ...p, mutedUntil: at(11).getTime() }, 'rule', at(10))).toBe(false)
    expect(shouldNotifySummary(p, false, at(10))).toBe(false)
    expect(shouldNotifySummary(p, true, at(10))).toBe(true)
    expect(shouldNotifySummary(p, true, at(23))).toBe(false)
    expect(shouldNotifySummary({ ...p, scope: 'off' }, true, at(10))).toBe(false)
  })
})
