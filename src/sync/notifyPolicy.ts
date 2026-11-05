// Bildirim politikası (R31): tek yerde karar. Önceden yalnız "kapsam" (hepsi/yıldızlı/kapalı) + zamanlanmış
// susturma vardı; 68 hesapta ya çok gürültü ya hiç sinyal. Şimdi:
//   · sessiz saatler (örn. 22:00–08:00, gece yarısını aşabilir)
//   · VIP gönderenler (adres ya da @alan): hesap yıldızlı olmasa da, sessiz saatte ve susturmada da bildirir
//   · kural eylemi "Bildir": kapsam dışı hesapta da bildirir; "acil" işaretliyse sessiz saati/susturmayı aşar
export interface NotifyPrefs {
  scope: 'all' | 'starred' | 'off'
  mutedUntil: number
  quietStart: string | null // "22:00"
  quietEnd: string | null // "08:00"
  vip: string[] // küçük harf: "ali@x.co" ya da "@firma.co"
}

export function parseNotifyPrefs(get: (k: string) => string | null | undefined): NotifyPrefs {
  const scope = get('notifyScope')
  const quiet = get('notifyQuiet') === '1'
  return {
    scope: scope === 'all' || scope === 'off' ? scope : 'starred',
    mutedUntil: Number(get('notifyMutedUntil') ?? 0) || 0,
    quietStart: quiet ? normTime(get('notifyQuietStart')) : null,
    quietEnd: quiet ? normTime(get('notifyQuietEnd')) : null,
    vip: parseVipList(get('notifyVip') ?? '')
  }
}

function normTime(v: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v ?? '')
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  return h < 24 && mi < 60 ? `${String(h).padStart(2, '0')}:${m[2]}` : null
}

export function parseVipList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) || /^@[^@\s]+\.[^@\s]+$/.test(s))
    )
  ]
}

/** Yerel saatle sessiz aralıkta mı; başlangıç > bitiş ise gece yarısını aşar (22:00–08:00) */
export function inQuietHours(now: Date, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
  const s = toMin(start)
  const e = toMin(end)
  return s < e ? cur >= s && cur < e : cur >= s || cur < e
}

export function isVip(fromAddr: string | null, vip: string[]): boolean {
  if (!fromAddr || !vip.length) return false
  const a = fromAddr.toLowerCase()
  const domain = a.slice(a.indexOf('@'))
  return vip.some((v) => (v.startsWith('@') ? domain === v || domain.endsWith(`.${v.slice(1)}`) : a === v))
}

export type NotifyReason = 'vip' | 'rule' | 'rule-urgent'

/** Tek mesaj için: bireysel bildirim gerekir mi (VIP ya da Bildir kuralı) */
export function shouldNotifyMessage(p: NotifyPrefs, reason: NotifyReason, now: Date): boolean {
  if (reason === 'vip' || reason === 'rule-urgent') return true
  if (now.getTime() < p.mutedUntil) return false
  return !inQuietHours(now, p.quietStart, p.quietEnd)
}

/** Hesap özeti ("N yeni mail") gösterilsin mi */
export function shouldNotifySummary(p: NotifyPrefs, starred: boolean, now: Date): boolean {
  if (p.scope === 'off' || (p.scope === 'starred' && !starred)) return false
  if (now.getTime() < p.mutedUntil) return false
  return !inQuietHours(now, p.quietStart, p.quietEnd)
}
