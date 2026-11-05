// Ayarlar › Bildirimler (yalnız web): bu kullanıcının anlık bildirim alan cihazları; ad, son başarılı gönderim, kaldır.
// Uç nokta ve anahtarlar sunucudan zaten gelmez.
import { useCallback, useEffect, useState } from 'react'
import { apiFetch } from '../apiFetch'
import { useStore } from '../store'
import { intlTag, t } from '../../../shared/i18n'
import { nativeBridge } from '../platform/nativeBridge'
import { disablePush, onPushChange } from '../webPushClient'

interface Device { id: number; label: string; createdAt: number; lastOkAt: number | null; current: boolean }

const day = (ms: number): string => new Date(ms).toLocaleDateString(intlTag())

async function load(): Promise<Device[]> {
  const r = await apiFetch('/api/push/devices')
  if (!r.ok) throw new Error(String(r.status))
  return ((await r.json()) as { devices: Device[] }).devices
}

export default function NotifyDevicesSettings() {
  const toast = useStore((s) => s.toast)
  const [list, setList] = useState<Device[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  // ilk yükleme başarısızsa satır içi hata + yeniden dene; sonraki yenilemelerde liste yerinde kalır, bildirim çıkar
  const refresh = useCallback((): Promise<void> => load().then((l) => { setLoadFailed(false); setList(l) }, () => { if (list) toast(t('set.nd.loadFailed')); else setLoadFailed(true) }), [toast, list])

  useEffect(() => { void load().then((l) => { setLoadFailed(false); setList(l) }, () => setLoadFailed(true)) }, [])

  useEffect(() => onPushChange(() => void refresh()), [refresh])

  const remove = async (d: Device): Promise<void> => {
    if (!window.confirm(t(d.current ? 'set.nd.removeCurrentConfirm' : 'set.nd.removeConfirm', { name: d.label || '—' }))) return
    setBusy(true)
    try {
      const r = await apiFetch(`/api/push/devices/${encodeURIComponent(String(d.id))}`, { method: 'DELETE' })
      if (!r.ok) toast(t('set.nd.removeFailed'))
      // yalnız kaydı silmek yetmez: tarayıcı aboneliği ve tercih dururken sonraki açılışta yeniden kaydolurdu
      else if (d.current) await (nativeBridge()?.plugin.unregisterPush() ?? disablePush())
    } catch {
      toast(t('set.nd.removeFailed'))
    }
    setBusy(false)
    await refresh()
  }

  if (!list) {
    if (!loadFailed) return null
    return (
      <div className="set-group" data-testid="notify-devices">
        <div className="set-field">
          <div className="sf-l"><div className="sf-t">{t('set.nd.title')}</div></div>
          <div className="sf-c">
            <span className="auth-error" role="alert">{t('set.nd.loadFailed')}</span>
            <button type="button" onClick={() => void refresh()}>{t('action.retry')}</button>
          </div>
        </div>
      </div>
    )
  }
  return (
    <div className="set-group" data-testid="notify-devices">
      <div className="set-field">
        <div className="sf-l"><div className="sf-t">{t('set.nd.title')}</div><div className="sf-h">{list.length ? t('set.nd.hint') : `${t('set.nd.hint')} ${t('set.nd.none')}`}</div></div>
      </div>
      {list.map((d) => (
        <div className="set-field" key={d.id}>
          <div className="sf-l">
            <div className="sf-t">{d.label || '—'}{d.current ? ` · ${t('set.nd.current')}` : ''}</div>
            <div className="sf-h">{t('set.nd.meta', { created: day(d.createdAt), ok: d.lastOkAt ? day(d.lastOkAt) : t('set.nd.neverOk') })}</div>
          </div>
          <div className="sf-c">
            <button type="button" aria-label={`${t('set.nd.remove')}: ${d.label || '—'}`} onClick={() => void remove(d)} disabled={busy}>{t('set.nd.remove')}</button>
          </div>
        </div>
      ))}
    </div>
  )
}
