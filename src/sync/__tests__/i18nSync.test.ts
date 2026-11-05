import { afterEach, describe, expect, it } from 'vitest'
import { CATALOGS } from '../../shared/i18n/locales'
import '../../shared/i18n/locales/all'
import { fmtTime, LOCALES, setLocale, t } from '../../shared/i18n'
import { AUTH_PAUSED_KEY, isAuthPausedDetail } from '../../shared/accountStatus'
import { classifyError, isMissingMailbox } from '../imapClient'

const fill = (s: string) => s.replace(/\{(\w+)\}/g, 'x')

describe('sync iletileri: dilden bağımsız davranış', () => {
  afterEach(() => setLocale('tr'))

  // classifyError/isMissingMailbox ileti metnine de bakar (limit, timeout, too many…): kendi
  // ürettiğimiz bir iletinin çevirisi hatayı başka sınıfa (ör. ağ → limit → host soğuması) düşürmesin
  it('çeviri, hata sınıflandırmasını değiştirmez', () => {
    const tr = CATALOGS.tr!
    const diff: string[] = []
    for (const l of LOCALES) {
      const cat = CATALOGS[l.id]
      if (!cat || l.id === 'tr') continue
      for (const [k, v] of Object.entries(cat)) {
        if (!k.startsWith('sync.') || tr[k] === undefined) continue
        // yalnız hata olarak fırlatılıp sınıflanabilen iletiler; ekranda gösterilen durum/bildirim metinleri
        // sınıflandırıcıdan geçmez (giriş engeli LoginDeniedError ile türünden tanınır)
        if (/^sync\.(status|notify|digest|rule|opKind|discover|trigger)\./.test(k) || k.startsWith('sync.oauth.page')) continue
        const a = new Error(fill(tr[k]))
        const b = new Error(fill(v))
        if (classifyError(a) !== classifyError(b) || isMissingMailbox(a) !== isMissingMailbox(b))
          diff.push(`${l.id} ${k}: ${classifyError(a)} → ${classifyError(b)}`)
      }
    }
    expect(diff).toEqual([])
  })

  it('sieve keys are identical in all 11 locales', () => {
    const keys = (cat: Record<string, string>): string[] => Object.keys(cat).filter((k) => k.startsWith('sync.sieve.') || k.startsWith('set.sieve.')).sort()
    const tr = keys(CATALOGS.tr!)
    expect(tr.length).toBeGreaterThan(90)
    expect(LOCALES).toHaveLength(11)
    for (const l of LOCALES) expect({ lang: l.id, keys: keys(CATALOGS[l.id]!) }).toEqual({ lang: l.id, keys: tr })
  })

  it('1. şifre reddi duraklaması her dilde tanınır, diğer durumlar tanınmaz', () => {
    const until = Date.UTC(2026, 8, 30, 12, 5)
    for (const l of LOCALES) {
      setLocale(l.id)
      expect(isAuthPausedDetail(t(AUTH_PAUSED_KEY, { time: fmtTime(until) }))).toBe(true)
      expect(isAuthPausedDetail(t('sync.status.authRejected'))).toBe(false)
      expect(isAuthPausedDetail(t('sync.status.rateLimited'))).toBe(false)
      expect(isAuthPausedDetail(t('sync.net.offline'))).toBe(false)
    }
    // eski sürümün DB'ye yazdığı metin
    expect(isAuthPausedDetail("Şifre reddedildi — 22:44'de bir kez daha denenecek")).toBe(true)
    expect(isAuthPausedDetail(null)).toBe(false)
  })
})
