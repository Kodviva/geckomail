import { useState, type KeyboardEvent } from 'react'
import { useStore } from '../store'
import LogoMark from './LogoMark'
import LanguagePicker from './LanguagePicker'
import { t } from '../../../shared/i18n'
import { platform } from '../platform'
import { OpenInBrowser } from './OpenInBrowser'
import Attribution from './Attribution'

export default function BootstrapAdmin() {
  const bootstrapAdmin = useStore((s) => s.bootstrapAdmin)
  const toast = useStore((s) => s.toast)
  const accountCount = useStore((s) => s.accountCount)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const web = platform.kind === 'web'

  const submit = async () => {
    if (!username.trim() || password.length < 8) {
      toast(t('acct.bootstrap.needCredentials'), 'error')
      return
    }
    if (password !== confirm) {
      toast(t('acct.bootstrap.passwordsMismatch'), 'error')
      return
    }
    setBusy(true)
    await bootstrapAdmin(username.trim(), password)
    setBusy(false)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !web) void submit()
  }

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
          <span className="auth-eyebrow">{t('acct.bootstrap.eyebrow')}</span>
          <div className="modal-title">{t('acct.bootstrap.title')}</div>
          {platform.native ? (
            <>
              <p className="auth-hint">{t('mobile.browser.bootstrap')}</p>
              <OpenInBrowser />
            </>
          ) : web ? (
            // web: ilk yönetici yalnız sunucu makinesinde CLI ile açılır (bootstrapAdmin RPC sunucu modunda kapalı)
            <>
              <p className="auth-hint">{t('acct.bootstrap.webInfo')}</p>
              <code className="auth-command">{t('acct.bootstrap.webCommand')}</code>
              <p className="auth-hint">{t('acct.bootstrap.webDockerHint')}</p>
              <code className="auth-command">{t('acct.bootstrap.webDockerCommand')}</code>
            </>
          ) : (
            <>
              <p className="auth-hint">{t('acct.bootstrap.hint')}</p>
              <label>
                {t('acct.common.username')}
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus disabled={busy} />
              </label>
              <label>
                {t('acct.common.passwordMin8')}
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
              </label>
              <label>
                {t('acct.bootstrap.passwordRepeat')}
                <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
              </label>
              <div className="modal-foot">
                <button className="primary" onClick={() => void submit()} disabled={busy}>
                  {busy ? t('acct.common.creating') : t('acct.bootstrap.create')}
                </button>
              </div>
            </>
          )}
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
