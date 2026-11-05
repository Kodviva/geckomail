// Ayarlar › Genel: sunucuya bağlan. Adres yoklanır, gerçek köken (IDN ise punycode) gösterilir; geçiş main'in onayıyla yeniden
// başlatarak olur. Bağlanılamayan sunucu sayfası da burada: sunucu penceresinde paketten açılır.
import { useState } from 'react'
import type { ProbeFailure, ProbeResult } from '../../../shared/desktopMode'
import { t } from '../../../shared/i18n'
import type { ServerModeApi } from '../platform'

export const REASON: Record<ProbeFailure, string> = {
  invalid: 'set.conn.err.invalid',
  insecure: 'set.conn.err.insecure',
  unreachable: 'set.conn.err.unreachable',
  notGecko: 'set.conn.err.notGecko',
  originMismatch: 'set.conn.err.originMismatch',
  apiMismatch: 'set.conn.err.apiMismatch'
}

export default function ServerConnect({ api }: { api: ServerModeApi }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ProbeResult | null>(null)
  const check = async (): Promise<void> => {
    setBusy(true)
    setResult(await api.probe(url).catch((): ProbeResult => ({ ok: false, reason: 'unreachable' })))
    setBusy(false)
  }
  return (
    <div className="set-group" data-testid="server-connect">
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">{t('set.conn.title')}</div>
          <div className="sf-h">{t('set.conn.hint')}</div>
          {result?.ok && <div className="sf-h">{t('set.conn.ready', { origin: result.origin })}</div>}
          {result && !result.ok && <div className="auth-error" role="alert">{t(REASON[result.reason])}</div>}
        </div>
        <div className="sf-c">
          <input
            type="url"
            aria-label={t('set.conn.address')}
            placeholder="https://posta.example.com"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setResult(null) }}
          />
          {result?.ok
            ? <button type="button" onClick={() => void api.connect(result.origin)}>{t('set.conn.connect')}</button>
            : <button type="button" disabled={busy || !url.trim()} onClick={() => void check()}>{t('set.conn.check')}</button>}
        </div>
      </div>
    </div>
  )
}

export function ServerUnreachable({ api, cert }: { api: { retry(): Promise<void>; local(): Promise<void> }; cert: boolean }) {
  return (
    <main className="server-unreachable" role="alert">
      <h1>{t('set.conn.unreachableTitle')}</h1>
      <p>{t(cert ? 'set.conn.unreachableCert' : 'set.conn.unreachableBody')}</p>
      <div>
        <button type="button" onClick={() => void api.retry()}>{t('action.retry')}</button>
        <button type="button" onClick={() => void api.local()}>{t('set.conn.backToLocal')}</button>
      </div>
    </main>
  )
}
