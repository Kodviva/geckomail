// Ayarlar › Bildirimler: hesap bazında aç/kapa (kişiye ait). Varsayılan açık; yalnız kapatılanlar kayıtlıdır.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { t } from '../../../shared/i18n'

type Mode = 'on' | 'off' | 'default'

export default function NotifyAccountPrefs() {
  const accounts = useStore((s) => s.accounts)
  const toast = useStore((s) => s.toast)
  // hesap → kayıtlı kip; kayıt yoksa varsayılan (açık)
  const [modes, setModes] = useState<Map<number, Mode> | null>(null)
  const [pending, setPending] = useState<Set<number>>(new Set())
  const [loadFailed, setLoadFailed] = useState(false)
  const [q, setQ] = useState('')
  // yüklenen "on" kaydı kapatıp açınca kaybolmasın: son kapalı olmayan kip hatırlanır
  const prior = useRef(new Map<number, Mode>())

  const load = useCallback((): void => {
    void rpc.call('getNotifyAccountPrefs', {}).then(
      (p) => {
        prior.current = new Map(p.filter((x) => x.mode !== 'off').map((x) => [x.accountId, x.mode as Mode]))
        setModes(new Map(p.map((x) => [x.accountId, x.mode as Mode])))
        setLoadFailed(false)
      },
      () => setLoadFailed(true)
    )
  }, [])

  useEffect(load, [load])

  const set = async (id: number, on: boolean): Promise<void> => {
    const prev = modes?.get(id)
    const next: Mode = on ? (prior.current.get(id) ?? 'default') : 'off'
    if (!on && prev && prev !== 'off') prior.current.set(id, prev)
    setPending((p) => new Set(p).add(id))
    setModes((m) => new Map(m).set(id, next))
    try {
      await rpc.call('setNotifyAccountPref', { accountId: id, mode: next })
    } catch {
      // yalnız bu hesabın girdisi geri alınır
      setModes((m) => { const n = new Map(m); if (prev === undefined) n.delete(id); else n.set(id, prev); return n })
      toast(t('set.nr.saveFailed'))
    } finally {
      setPending((p) => { const n = new Set(p); n.delete(id); return n })
    }
  }

  if (!modes) {
    if (!loadFailed) return null
    return (
      <div className="set-group" data-testid="notify-accounts">
        <div className="set-field">
          <div className="sf-l"><div className="sf-t">{t('set.na.title')}</div></div>
          <div className="sf-c">
            <span className="auth-error" role="alert">{t('set.nr.loadFailed')}</span>
            <button type="button" onClick={load}>{t('action.retry')}</button>
          </div>
        </div>
      </div>
    )
  }
  const needle = q.trim().toLowerCase()
  const shown = accounts.filter((a) => !needle || a.email.toLowerCase().includes(needle) || (a.displayName ?? '').toLowerCase().includes(needle))
  return (
    <div className="set-group" data-testid="notify-accounts">
      <div className="set-field">
        <div className="sf-l"><div className="sf-t">{t('set.na.title')}</div><div className="sf-h">{t('set.na.hint')}</div></div>
      </div>
      <div className="set-field">
        <input type="search" aria-label={t('set.na.search')} placeholder={t('set.na.search')} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%' }} />
      </div>
      {shown.length === 0 && <div className="set-field"><div className="sf-h">{t('set.na.none')}</div></div>}
      {shown.map((a) => (
        <div className="set-field" key={a.id}>
          <div className="sf-l"><div className="sf-t">{a.email}</div></div>
          <div className="sf-c">
            <input type="checkbox" aria-label={t('set.na.toggle', { email: a.email })} checked={modes.get(a.id) !== 'off'} onChange={(e) => void set(a.id, e.target.checked)} disabled={pending.has(a.id)} />
          </div>
        </div>
      ))}
    </div>
  )
}
