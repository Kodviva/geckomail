// Mobil ilk açılış: sunucu adresi. Yazılan adres doğrulanır, hello ile sınanır, sonra yerel katmana yazılır ve sayfa yeniden yüklenir
// (CSP yeni sunucuya göre daralır). Sunucu değişirken bu cihazdaki yerel kopya ve arayüz tercihleri silinir; oturumu eklenti siler.
import { useState, type FormEvent } from 'react'
import { getLocale, t } from '../../../shared/i18n'
import { applyLocale } from '../locale'
import { wipeOffline } from '../offline/store'
import { nativeBridge } from '../platform/nativeBridge'
import { parseServerUrl, probeServer, type ProbeResult, type ServerUrlError } from '../serverUrl'
import LogoMark from './LogoMark'

const ERRORS: Record<ServerUrlError | Exclude<ProbeResult, 'ok'> | 'failed', string> = {
  empty: 'mobile.server.err.empty', invalid: 'mobile.server.err.invalid', insecure: 'mobile.server.err.insecure',
  credentials: 'mobile.server.err.credentials', notGecko: 'mobile.server.err.notGecko', tooOld: 'mobile.server.err.tooOld',
  unreachable: 'mobile.server.err.unreachable', failed: 'mobile.server.err.failed'
}

async function wipeLocal(): Promise<void> {
  await wipeOffline().catch(() => {})
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    /* depo kapalı: silinecek bir şey de yok */
  }
  await applyLocale(getLocale()) // karşılama ekranı yeniden sorulmasın
}

export default function ServerSetup({ onCancel }: { onCancel?: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<keyof typeof ERRORS | null>(null)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const host = nativeBridge()
    if (busy || !host) return
    const parsed = parseServerUrl(text, { dev: host.dev })
    if (!parsed.ok) return setError(parsed.reason)
    setBusy(true)
    setError(null)
    const probe = await probeServer(parsed.origin)
    if (probe !== 'ok') {
      setBusy(false)
      return setError(probe)
    }
    try {
      if (host.serverOrigin && parsed.origin !== host.serverOrigin) await wipeLocal()
      await host.plugin.setServer({ origin: parsed.origin })
      window.location.reload()
    } catch {
      setBusy(false)
      setError('failed')
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-content">
        <div className="auth-lockup">
          <LogoMark className="logo-mark" />
          <div className="auth-wordmark">Gecko<span>Mail</span></div>
        </div>
        <form className="modal auth-card" onSubmit={(e) => void submit(e)} data-testid="server-setup">
          <div className="modal-title">{t('mobile.server.title')}</div>
          <p className="auth-hint">{t('mobile.server.hint')}</p>
          <label>
            {t('mobile.server.label')}
            <input
              value={text} onChange={(e) => setText(e.target.value)} placeholder={t('mobile.server.placeholder')} disabled={busy} autoFocus
              inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete="url"
            />
          </label>
          {error && <p className="auth-error" role="alert">{t(ERRORS[error])}</p>}
          <div className="modal-foot">
            {onCancel && <button type="button" onClick={onCancel} disabled={busy}>{t('action.back')}</button>}
            <button className="primary" type="submit" disabled={busy || !text.trim()}>
              {busy ? t('mobile.server.checking') : t('mobile.server.connect')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
