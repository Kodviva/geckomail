import { useEffect, useState, type KeyboardEvent } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import LogoMark from './LogoMark'
import LanguagePicker from './LanguagePicker'
import { t } from '../../../shared/i18n'
import { platform } from '../platform'
import Attribution from './Attribution'

export default function Login() {
  const login = useStore((s) => s.login)
  const loginBiometric = useStore((s) => s.loginBiometric)
  const accountCount = useStore((s) => s.accountCount)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [bioUser, setBioUser] = useState<string | null>(null)
  const [touchId, setTouchId] = useState(false)

  useEffect(() => {
    void platform.biometricAvailable().then(setTouchId).catch(() => setTouchId(false))
    // web: girişten önce RPC bağlantısı yok, Touch ID de yok (giriş /api/login ile)
    if (platform.kind === 'web') return
    void rpc
      .call('getLoginBiometric', {})
      .then((r) => setBioUser(r.username))
      .catch(() => setBioUser(null))
  }, [])

  const submit = async () => {
    if (!username.trim() || !password) return
    setBusy(true)
    await login(username.trim(), password)
    setBusy(false)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') void submit()
  }

  const showBio = !!bioUser && touchId

  return (
    <div className="auth-screen">
      <div className="dragbar" />
      <LanguagePicker />
      <LogoMark className="logo-mark auth-bleed" />
      <div className="auth-content">
        <div className="auth-lockup">
          <LogoMark className="logo-mark" />
          <div className="auth-wordmark">
            Gecko<span>Mail</span>
          </div>
        </div>
        <div className="modal auth-card" onKeyDown={onKeyDown}>
          <div className="modal-title">{t('acct.login.title')}</div>
          {showBio && (
            <>
              <button type="button" className="bio-login" onClick={() => void loginBiometric()} disabled={busy}>
                <svg className="icon lg"><use href="#i-fingerprint" /></svg>
                {t('acct.login.touchId', { user: bioUser })}
              </button>
              <div className="auth-sep"><span>{t('acct.login.orPassword')}</span></div>
            </>
          )}
          <label>
            {t('acct.common.username')}
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!showBio} disabled={busy} />
          </label>
          <label>
            {t('acct.common.password')}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          </label>
          <div className="modal-foot">
            <button className="primary" onClick={() => void submit()} disabled={busy || !username.trim() || !password}>
              {busy ? t('acct.login.signingIn') : t('acct.login.signIn')}
            </button>
          </div>
        </div>
        {accountCount > 0 && (
          <div className="auth-status">
            <svg className="eye eye-ok pulse" viewBox="0 0 10 10">
              <circle cx="5" cy="5" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="5.8" cy="4.2" r="1.5" fill="currentColor" />
            </svg>
            {t('acct.common.accountsWatched', { count: accountCount })}
          </div>
        )}
      </div>
      <div className="auth-footnote"><Attribution /></div>
    </div>
  )
}
