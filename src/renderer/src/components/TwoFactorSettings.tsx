// Ayarlar › Güvenlik (yalnız web, girişli): kendi hesabının iki adımlı doğrulaması (durum, aç, kapat) ve
// yönetici için "herkese zorunlu" anahtarı. Masaüstü girişi TOTP kullanmaz (R7), bu bölüm orada gösterilmez.
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { t } from '../../../shared/i18n'
import TwoFactorSetup, { TotpCodeInput } from './TwoFactorSetup'
import { normalizeCode } from '../webLoginFlow'

type Mode = { kind: 'idle' } | { kind: 'enroll'; otpauthUri: string; secretBase32: string } | { kind: 'disable' }

export default function TwoFactorSettings({ isAdmin }: { isAdmin: boolean }) {
  const toast = useStore((s) => s.toast)
  const disableTwoFactor = useStore((s) => s.disableTwoFactor)
  const [status, setStatus] = useState<{ enabled: boolean; required: boolean } | null>(null)
  const [mode, setMode] = useState<Mode>({ kind: 'idle' })
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void rpc
      .call('twoFactorStatus', {})
      .then(setStatus)
      .catch((e) => toast(String((e as Error).message)))
  }, [toast])

  const reset = (): void => {
    setMode({ kind: 'idle' })
    setCode('')
  }

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const begin = () =>
    run(async () => {
      const r = await rpc.call('twoFactorBegin', {})
      setCode('')
      setMode({ kind: 'enroll', otpauthUri: r.otpauthUri, secretBase32: r.secretBase32 })
    })

  const confirm = () =>
    run(async () => {
      await rpc.call('twoFactorConfirm', { code: normalizeCode(code) })
      reset()
      setStatus((s) => (s ? { ...s, enabled: true } : s))
      toast(t('set.2fa.enabledToast'), 'info')
    })

  const disable = async (): Promise<void> => {
    setBusy(true)
    const ok = await disableTwoFactor(normalizeCode(code))
    setBusy(false)
    // başarıda sunucu oturumları kapatır; bileşen giriş ekranıyla birlikte kaldırılır
    if (ok) reset()
  }

  // diğer ayar kutuları gibi anında görünür; sunucu reddederse geri alınır
  const setRequired = async (on: boolean): Promise<void> => {
    setStatus((s) => (s ? { ...s, required: on } : s))
    try {
      await rpc.call('setPrefs', { values: { require2fa: on ? '1' : '0' } })
    } catch (e) {
      setStatus((s) => (s ? { ...s, required: !on } : s))
      toast(String((e as Error).message))
    }
  }

  if (!status) return null
  const codeOk = /^[0-9]{6}$/.test(normalizeCode(code))

  return (
    <div className="set-group" data-testid="tfa-settings">
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">{t('set.2fa.title')}</div>
          <div className="sf-h">{status.enabled && status.required ? t('set.2fa.requiredNote') : t('set.2fa.hint')}</div>
        </div>
        <div className="sf-c">
          <span className={`vault-tag ${status.enabled ? 'on' : ''}`}>{status.enabled ? t('set.2fa.on') : t('set.2fa.off')}</span>
          {mode.kind === 'idle' &&
            (status.enabled ? (
              <button type="button" onClick={() => setMode({ kind: 'disable' })} disabled={busy || status.required}>
                {t('set.2fa.disable')}
              </button>
            ) : (
              <button type="button" className="primary" onClick={() => void begin()} disabled={busy}>
                {t('set.2fa.enable')}
              </button>
            ))}
        </div>
      </div>
      {mode.kind === 'enroll' && (
        <div className="set-field set-field-col">
          <TwoFactorSetup otpauthUri={mode.otpauthUri} secretBase32={mode.secretBase32} code={code} onCode={setCode} disabled={busy} autoFocus />
          <div className="settings-actions">
            <button type="button" onClick={reset} disabled={busy}>{t('action.cancel')}</button>
            <button type="button" className="primary" onClick={() => void confirm()} disabled={busy || !codeOk}>{t('set.2fa.confirm')}</button>
          </div>
        </div>
      )}
      {mode.kind === 'disable' && (
        <div className="set-field set-field-col">
          <p className="auth-hint">{t('set.2fa.disableHint')}</p>
          <TotpCodeInput value={code} onChange={setCode} disabled={busy} autoFocus />
          <div className="settings-actions">
            <button type="button" onClick={reset} disabled={busy}>{t('action.cancel')}</button>
            <button type="button" className="danger" onClick={() => void disable()} disabled={busy || !codeOk}>{t('set.2fa.disable')}</button>
          </div>
        </div>
      )}
      {isAdmin && (
        <div className="set-field">
          <div className="sf-l">
            <div className="sf-t">{t('set.2fa.require')}</div>
            <div className="sf-h">{t('set.2fa.requireHint')}</div>
          </div>
          <div className="sf-c">
            <input
              type="checkbox"
              aria-label={t('set.2fa.require')}
              checked={status.required}
              onChange={(e) => void setRequired(e.target.checked)}
              disabled={busy}
            />
          </div>
        </div>
      )}
    </div>
  )
}
