// Mobil uygulama kilidi: arka plandan dönüşte süre dolduysa içerik opak ekranla örtülür, biyometri ya da cihaz kilidi ister.
// Ayarlar › Güvenlik'teki satır da burada. Kilit ayarı yerel depodadır (eklenti).
import { useEffect, useState } from 'react'
import { t } from '../../../shared/i18n'
import {
  appStateChanged, duringPrompt, isLocked, lockConfig, LOCK_TIMEOUTS, onLockChange, rememberLockConfig, resolveColdLock, unlockApp
} from '../appLock'
import { platform } from '../platform'
import { nativeBridge, type LockConfig } from '../platform/nativeBridge'
import { useStore } from '../store'
import LogoMark from './LogoMark'

/** boot.ts @capacitor/app durum olayını bu özel olaya çevirir: arayüz Capacitor görmez */
export const APP_STATE_EVENT = 'gecko:app-state'

export function useAppLocked(): boolean {
  const [locked, setLocked] = useState(isLocked)
  useEffect(() => onLockChange(setLocked), [])
  return locked
}

export default function AppLock() {
  const resume = useStore((s) => s.resumeAfterLock)
  const logoutFromLock = useStore((s) => s.logoutFromLock)
  const locked = useAppLocked()
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const prompt = async (): Promise<void> => {
    const host = nativeBridge()
    // ayar okunamamıştı: yeniden denenir, kilit kapalıysa kimlik sorulmaz
    if (host && lockConfig() === null && (await resolveColdLock(host.plugin, resume)) === 'open') return
    setBusy(true)
    const ok = await duringPrompt(() => platform.promptBiometric(t('mobile.faceid.reason')))
    setBusy(false)
    if (ok) unlockApp(resume)
  }

  // cihaz kodu kaldırıldıysa ya da biyometri gittiyse kilit açılamaz: kullanıcı mahsur kalmasın. Çıkış postayı göstermez
  const signOut = async (): Promise<void> => {
    if (!window.confirm(t('mobile.lock.signOutConfirm'))) return
    setBusy(true)
    try {
      await logoutFromLock()
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const host = nativeBridge()
    if (!host) return
    let live = true
    void resolveColdLock(host.plugin, resume).then((r) => {
      if (!live) return
      setLoading(false)
      if (r === 'prompt') void prompt()
    })
    const onState = (e: Event): void => {
      const active = (e as CustomEvent<{ active: boolean }>).detail.active
      void appStateChanged(active, host.plugin).then((ask) => {
        if (ask && live) void prompt()
      })
    }
    window.addEventListener(APP_STATE_EVENT, onState)
    return () => {
      live = false
      window.removeEventListener(APP_STATE_EVENT, onState)
    }
    // prompt ve resume sabit: yalnız ilk açılışta bağlanır
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!locked) return null
  return (
    <div className="app-lock" data-testid="app-lock">
      {!loading && (
        <>
          <LogoMark className="logo-mark" />
          <div className="modal-title">{t('mobile.lock.title')}</div>
          <button className="primary" type="button" onClick={() => void prompt()} disabled={busy}>{t('mobile.lock.unlock')}</button>
          <button className="link-btn" type="button" onClick={() => void signOut()} disabled={busy}>{t('mobile.lock.signOut')}</button>
        </>
      )}
    </div>
  )
}

const timeoutLabel = (ms: number): string => (ms === 0 ? t('mobile.lock.immediately') : t('mobile.lock.minutes', { count: ms / 60_000 }))

export function AppLockSettings() {
  const [config, setConfig] = useState<LockConfig | null>(null)
  const [available, setAvailable] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const host = nativeBridge()
    if (!host) return
    // okunamazsa ayar gösterilmez: kilit açıkken "kapalı" görünmesin
    void host.plugin.getLock().then(({ enabled, timeoutMs }) => setConfig({ enabled, timeoutMs }), () => setConfig(lockConfig()))
    void platform.biometricAvailable().then(setAvailable)
  }, [])

  const save = async (next: LockConfig): Promise<void> => {
    const host = nativeBridge()
    if (!host) return
    setBusy(true)
    try {
      // açarken kimlik doğrulanır: sonradan açamayacağı kilidi kimse kurmasın
      if (next.enabled && !config?.enabled && !(await duringPrompt(() => platform.promptBiometric(t('mobile.faceid.reason'))))) return
      // zayıflatma için kimliği yerel katman sorar: JS atlayamaz
      await duringPrompt(() => host.plugin.setLock(next))
      rememberLockConfig(next)
      setConfig(next)
    } catch {
      /* ayar değişmedi: anahtar eski değerde kalır */
    } finally {
      setBusy(false)
    }
  }

  if (!config) return null
  return (
    <div className="set-group" data-testid="app-lock-settings">
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">{t('mobile.lock.setting')}</div>
          <div className="sf-h">{available ? t('mobile.lock.settingHint') : t('mobile.lock.unavailable')}</div>
        </div>
        <div className="sf-c">
          <input type="checkbox" aria-label={t('mobile.lock.setting')} checked={config.enabled} disabled={busy || !available} onChange={(e) => void save({ ...config, enabled: e.target.checked })} />
        </div>
      </div>
      {config.enabled && (
        <div className="set-field">
          <div className="sf-l"><div className="sf-t">{t('mobile.lock.timeout')}</div></div>
          <div className="sf-c">
            <select value={config.timeoutMs} disabled={busy} onChange={(e) => void save({ ...config, timeoutMs: Number(e.target.value) })}>
              {LOCK_TIMEOUTS.map((ms) => <option key={ms} value={ms}>{timeoutLabel(ms)}</option>)}
            </select>
          </div>
        </div>
      )}
    </div>
  )
}
