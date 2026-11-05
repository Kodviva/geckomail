// Ayarlar › Güvenlik (yalnız web, girişli): kullanıcının kendi passkey'leri (liste, ekleme, silme). Tarayıcı
// passkey desteklemiyorsa ekleme gizlenir; var olanlar başka cihazdan silinebilsin diye liste kalır. Ekleme parola
// (2FA açıksa kod) ister; ikisi yalnız bu formun durumunda, her denemeden sonra silinir, hiçbir depoya yazılmaz.
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { TotpCodeInput } from './TwoFactorSetup'
import { normalizeCode } from '../webLoginFlow'
import { intlTag, t } from '../../../shared/i18n'
import { passkeySupported, webPasskeyAdd, webPasskeyList, webPasskeyRemove, type PasskeyInfo } from '../webPasskey'

const day = (ms: number): string => new Date(ms).toLocaleDateString(intlTag())

export default function PasskeySettings() {
  const toast = useStore((s) => s.toast)
  const [list, setList] = useState<PasskeyInfo[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [needCode, setNeedCode] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = (): Promise<void> => webPasskeyList().then(setList, () => toast(t('acct.login.webNetwork')))

  useEffect(() => {
    void webPasskeyList().then(setList, () => toast(t('acct.login.webNetwork')))
    // kod alanı baştan görünsün; öğrenilemezse sunucu ister (totpRequired)
    void rpc.call('twoFactorStatus', {}).then((s) => setNeedCode(s.enabled), () => {})
  }, [toast])

  const closeForm = (): void => {
    setAdding(false)
    setPassword('')
    setCode('')
    setError(null)
  }

  const add = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const r = await webPasskeyAdd(name.trim(), { password, ...(code.trim() ? { totp: normalizeCode(code) } : {}) })
    setBusy(false)
    if (r === 'totpRequired') {
      setNeedCode(true)
      return
    }
    setPassword('')
    setCode('')
    if (r === 'cancelled') return
    if (r === 'bad') return setError(t('set.passkey.reauthBad'))
    if (r === 'locked') return setError(t('acct.login.webLocked'))
    if (r !== 'ok') {
      toast(t(r === 'duplicate' ? 'set.passkey.duplicate' : 'set.passkey.failed'))
      return
    }
    closeForm()
    setName('')
    toast(t('set.passkey.added'), 'info')
    await refresh()
  }

  const remove = async (p: PasskeyInfo): Promise<void> => {
    if (!window.confirm(t('set.passkey.deleteConfirm', { name: p.name }))) return
    setBusy(true)
    const ok = await webPasskeyRemove(p.id)
    setBusy(false)
    if (!ok) toast(t('set.passkey.removeFailed'))
    await refresh()
  }

  if (!list) return null

  return (
    <div className="set-group" data-testid="passkey-settings">
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">{t('set.passkey.title')}</div>
          <div className="sf-h">{list.length ? t('set.passkey.hint') : `${t('set.passkey.hint')} ${t('set.passkey.none')}`}</div>
        </div>
        {passkeySupported() && !adding && (
          <div className="sf-c">
            <button type="button" onClick={() => setAdding(true)} disabled={busy}>{t('set.passkey.add')}</button>
          </div>
        )}
      </div>
      {adding && (
        <div className="set-field set-field-col">
          <label>
            {t('set.passkey.name')}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('set.passkey.namePlaceholder')}
              maxLength={64}
              disabled={busy}
              autoFocus
            />
          </label>
          <p className="auth-hint">{t('set.passkey.reauthHint')}</p>
          <label>
            {t('acct.common.password')}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={busy} />
          </label>
          {needCode && <TotpCodeInput value={code} onChange={setCode} disabled={busy} />}
          {error && <p className="auth-error" role="alert">{error}</p>}
          <div className="settings-actions">
            <button type="button" onClick={closeForm} disabled={busy}>{t('action.cancel')}</button>
            <button
              type="button"
              className="primary"
              onClick={() => void add()}
              disabled={busy || !name.trim() || !password || (needCode && !/^[0-9]{6}$/.test(normalizeCode(code)))}
            >
              {t('set.passkey.continue')}
            </button>
          </div>
        </div>
      )}
      {list.map((p) => (
        <div className="set-field" key={p.id}>
          <div className="sf-l">
            <div className="sf-t">{p.name}</div>
            <div className="sf-h">
              {t('set.passkey.meta', { created: day(p.createdAt), used: p.lastUsedAt ? day(p.lastUsedAt) : t('set.passkey.neverUsed') })}
            </div>
          </div>
          <div className="sf-c">
            <button type="button" aria-label={`${t('action.delete')}: ${p.name}`} onClick={() => void remove(p)} disabled={busy}>{t('action.delete')}</button>
          </div>
        </div>
      ))}
    </div>
  )
}
