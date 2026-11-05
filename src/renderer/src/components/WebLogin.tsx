// Web giriş ekranı (sunucu modu): kullanıcı adı + parola → gerekirse TOTP kodu ya da zorunlu 2FA kurulumu.
// Parola yalnız bu bileşenin durumunda ve yalnız akış boyunca; girişte ve iptalde silinir, bileşen
// kaldırılınca (oturum açıldı) durumuyla birlikte gider. Hiçbir depoya yazılmaz.
import { useState, type KeyboardEvent } from 'react'
import { useStore } from '../store'
import LogoMark from './LogoMark'
import LanguagePicker from './LanguagePicker'
import TwoFactorSetup, { TotpCodeInput } from './TwoFactorSetup'
import { t } from '../../../shared/i18n'
import { flowSubmit, type FlowError, type FlowView } from '../webLoginFlow'
import { webLogin, webSetupBegin, webSetupConfirm } from '../webAuth'
import { passkeySupported, webPasskeyLogin } from '../webPasskey'
import { platform } from '../platform'
import { OpenInBrowser } from './OpenInBrowser'
import ServerSetup from './ServerSetup'
import Attribution from './Attribution'

const API = { login: webLogin, setupBegin: webSetupBegin, setupConfirm: webSetupConfirm }

const errorText = (e: FlowError): string =>
  e === 'bad' ? t('sync.auth.badCredentials')
    : e === 'locked' ? t('acct.login.webLocked')
      : e === 'network' ? t('acct.login.webNetwork')
        : e === 'passkey' ? t('acct.login.passkeyFailed')
          : e === 'browser' ? t('mobile.browser.setup2fa')
            : t('acct.2fa.badCode')

export default function WebLogin() {
  const completeWebLogin = useStore((s) => s.completeWebLogin)
  const [view, setView] = useState<FlowView>({ kind: 'credentials' })
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [changingServer, setChangingServer] = useState(false)

  const changeServer = (): void => {
    if (window.confirm(t('mobile.login.changeConfirm'))) setChangingServer(true)
  }

  const cancel = (): void => {
    setPassword('')
    setCode('')
    setView({ kind: 'credentials' })
  }

  const submit = async (): Promise<void> => {
    if (busy || !username.trim() || !password) return
    if (view.kind !== 'credentials' && !code.trim()) return
    setBusy(true)
    const next = await flowSubmit(view, { username: username.trim(), password, code }, API)
    setBusy(false)
    if (next.kind === 'done') {
      setPassword('')
      setCode('')
      completeWebLogin(next.user)
      return
    }
    // akış başa döndüyse (kilit, parola değişti) parola yeniden istenir
    if (next.kind === 'credentials' && view.kind !== 'credentials') setPassword('')
    if (next.kind !== view.kind || next.error === 'totpBad') setCode('')
    setView(next)
  }

  /** Parola + TOTP yerine geçer; kullanıcı adı sorulmaz, istemi kapatmak hata sayılmaz */
  const passkey = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    const r = await webPasskeyLogin()
    setBusy(false)
    if (r.ok) {
      setPassword('')
      completeWebLogin(r.user)
      return
    }
    if (r.reason !== 'cancelled') setView({ kind: 'credentials', error: r.reason === 'failed' ? 'passkey' : r.reason })
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') void submit()
  }

  const error = view.kind !== 'done' ? view.error : undefined

  if (changingServer) return <ServerSetup onCancel={() => setChangingServer(false)} />

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
          {view.kind === 'credentials' && (
            <>
              <div className="modal-title">{t('acct.login.title')}</div>
              <label>
                {t('acct.common.username')}
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus disabled={busy} />
              </label>
              <label>
                {t('acct.common.password')}
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" disabled={busy} />
              </label>
            </>
          )}
          {view.kind === 'totp' && (
            <>
              <div className="modal-title">{t('acct.2fa.title')}</div>
              <p className="auth-hint">{t('acct.2fa.codeHint')}</p>
              <TotpCodeInput value={code} onChange={setCode} disabled={busy} autoFocus />
            </>
          )}
          {view.kind === 'setup' && (
            <>
              <div className="modal-title">{t('acct.2fa.setupTitle')}</div>
              <p className="auth-hint">{t('acct.2fa.setupRequired')}</p>
              <TwoFactorSetup otpauthUri={view.otpauthUri} secretBase32={view.secretBase32} code={code} onCode={setCode} disabled={busy} autoFocus />
            </>
          )}
          {error && (
            <p className="auth-error" role="alert">
              {errorText(error)}
            </p>
          )}
          {error === 'browser' && <OpenInBrowser />}
          <div className="modal-foot">
            {view.kind !== 'credentials' && (
              <button type="button" onClick={cancel} disabled={busy}>
                {t('action.back')}
              </button>
            )}
            {view.kind === 'credentials' && passkeySupported() && (
              <button type="button" onClick={() => void passkey()} disabled={busy}>
                {t('acct.login.passkey')}
              </button>
            )}
            {view.kind === 'credentials' ? (
              <button className="primary" onClick={() => void submit()} disabled={busy || !username.trim() || !password}>
                {busy ? t('acct.login.signingIn') : t('acct.login.signIn')}
              </button>
            ) : (
              <button className="primary" onClick={() => void submit()} disabled={busy || !code.trim()}>
                {busy ? t('acct.2fa.verifying') : t('acct.2fa.verify')}
              </button>
            )}
          </div>
          {platform.serverOrigin && (
            <div className="auth-server" data-testid="login-server">
              <span>{t('mobile.login.server', { host: new URL(platform.serverOrigin).host })}</span>
              <button type="button" className="link-btn" onClick={changeServer} disabled={busy}>{t('mobile.login.change')}</button>
            </div>
          )}
        </div>
      </div>
      <div className="auth-footnote"><Attribution /></div>
    </div>
  )
}
