import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { resolveMailServers } from '../../../shared/mailProviders'
import type { DiscoveredServers, ImportPreviewRow } from '../../../shared/rpc'
import Modal from './Modal'
import { OAUTH_LABEL, oauthProviderFor, useOAuthConnect } from './useOAuthConnect'
import { t } from '../../../shared/i18n'
import { rich } from '../rich'
import { platform } from '../platform'

type Kind = 'mobileconfig' | 'csv'
type Mode = 'manual' | 'file'

const csvEscape = (v: string): string => `"${v.replace(/"/g, '""')}"`


export default function ImportWizard() {
  const setImportOpen = useStore((s) => s.setImportOpen)
  const refreshAccounts = useStore((s) => s.refreshAccounts)
  const refreshList = useStore((s) => s.refreshList)
  const toast = useStore((s) => s.toast)
  const [mode, setMode] = useState<Mode>('manual')
  const [preview, setPreview] = useState<ImportPreviewRow[] | null>(null)
  const [content, setContent] = useState('')
  const [kind, setKind] = useState<Kind>('mobileconfig')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<{ added: number; updated: number; skipped: number } | null>(null)
  const [srcPath, setSrcPath] = useState<string | null>(null)
  const [trashed, setTrashed] = useState(false)

  // elle giriş
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [imapHost, setImapHost] = useState('')
  const [imapPort, setImapPort] = useState('')
  const [smtpHost, setSmtpHost] = useState('')
  const [smtpPort, setSmtpPort] = useState('')

  // e-postadan sunucu ayarlarını algıla: önce anında tablo (Gmail/Outlook/…), sonra ağ keşfi
  // (autoconfig, SRV, MX, Thunderbird veritabanı) — kendi sunucusunu kullanan alan adları için
  const quick = email.includes('@') ? resolveMailServers(email.trim()) : null
  // keşif sonucu hangi adres içinse onunla saklanır: adres değişince eski sonuç kullanılmaz
  const [discovered, setDiscovered] = useState<{ email: string; servers: DiscoveredServers } | null>(null)
  const found = discovered?.email === email.trim() ? discovered.servers : null
  const [discovering, setDiscovering] = useState(false)
  useEffect(() => {
    const e = email.trim()
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) return
    let cancelled = false
    const timer = setTimeout(() => {
      setDiscovering(true)
      rpc
        .call('discoverMailServers', { email: e })
        .then((r) => !cancelled && setDiscovered({ email: e, servers: r }))
        .catch(() => {})
        .finally(() => !cancelled && setDiscovering(false))
    }, 600)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [email])
  const auto = found ?? quick
  // Gmail / Microsoft 365: şifre yerine sağlayıcının kendi girişi (uygulama şifresi gerekmez)
  const oauthProvider = oauthProviderFor(auto?.label)
  const oauth = useOAuthConnect()
  const [oauthReady, setOauthReady] = useState<{ google: boolean; microsoft: boolean } | null>(null)
  useEffect(() => {
    void rpc.call('oauthGetClients', {}).then((c) => setOauthReady({ google: c.googleReady, microsoft: c.microsoftReady })).catch(() => {})
  }, [])
  // adres değişirse ya da pencere kapanırsa bekleyen akış kapanır (eski düğme/durum kalmasın)
  const cancelOAuth = oauth.cancel
  useEffect(() => cancelOAuth, [email, cancelOAuth])
  const canOAuth = !!oauthProvider && !!oauthReady?.[oauthProvider]
  const connectOAuth = async () => {
    if (!oauthProvider) return
    const r = await oauth.connect(oauthProvider, { email: email.trim() || undefined })
    if (r) setDone({ added: r.added ? 1 : 0, updated: r.added ? 0 : 1, skipped: 0 })
  }

  const pickFile = async (file: File) => {
    setBusy(true)
    try {
      setSrcPath(platform.filePath(file))
      const text = await file.text()
      const k: Kind = file.name.toLowerCase().endsWith('.csv') ? 'csv' : 'mobileconfig'
      const rows = await rpc.call('importPreview', { kind: k, content: text })
      setContent(text)
      setKind(k)
      setPreview(rows)
      if (!rows.length) toast(t('acct.import.noAccountsInFile'), 'error')
    } catch (e) {
      toast(t('acct.import.fileReadFailed', { error: String((e as Error).message) }))
    } finally {
      setBusy(false)
    }
  }

  // elle giriş → tek satırlık CSV kur, mevcut CSV yolunu kullan (host/port boşsa backend mail.domain türetir)
  const previewManual = async () => {
    if (!email.trim() || !password) return
    setBusy(true)
    try {
      const header = 'email,password,imap_host,imap_port,smtp_host,smtp_port'
      const f = found
      const row = [
        email.trim(),
        password,
        imapHost.trim() || f?.imapHost || '',
        imapPort.trim() || (f ? String(f.imapPort) : ''),
        smtpHost.trim() || f?.smtpHost || '',
        smtpPort.trim() || (f ? String(f.smtpPort) : '')
      ]
        .map(csvEscape)
        .join(',')
      const text = `${header}\n${row}`
      const rows = await rpc.call('importPreview', { kind: 'csv', content: text })
      setContent(text)
      setKind('csv')
      setSrcPath(null) // elle giriş — silinecek kaynak dosya yok
      setPreview(rows)
      if (!rows.length) toast(t('acct.import.verifyFailed'), 'error')
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const runImport = async () => {
    setBusy(true)
    try {
      const res = await rpc.call('importAccounts', { kind, content })
      setDone(res)
      await refreshAccounts()
      await refreshList(true)
    } catch (e) {
      toast(t('acct.import.importFailed', { error: String((e as Error).message) }))
    } finally {
      setBusy(false)
    }
  }

  const importable = preview?.filter((r) => r.hasPassword).length ?? 0

  return (
    <Modal onClose={() => setImportOpen(false)} closeOnBackdrop={false} className="import" confirmOnDirty>
        <div className="modal-title">{t('acct.common.addAccount')}</div>

        {!preview && !done && (
          <>
            <div className="segmented" role="tablist" style={{ alignSelf: 'flex-start' }}>
              <button role="tab" aria-selected={mode === 'manual'} className={mode === 'manual' ? 'on' : ''} onClick={() => setMode('manual')}>
                <svg className="icon sm"><use href="#i-pencil" /></svg> {t('acct.import.manual')}
              </button>
              <button role="tab" aria-selected={mode === 'file'} className={mode === 'file' ? 'on' : ''} onClick={() => setMode('file')}>
                <svg className="icon sm"><use href="#i-plus" /></svg> {t('acct.import.fromFile')}
              </button>
            </div>

            {mode === 'manual' && (
              <>
                <div className="cc-row">
                  <label>
                    {t('acct.common.email')}
                    <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t('acct.import.emailPlaceholder')} autoFocus autoComplete="off" />
                  </label>
                  <label>
                    {t('acct.common.password')}
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                  </label>
                </div>
                {auto && (
                  <div className={`provider-hint ${auto.appPassword ? 'warn' : ''}`}>
                    <svg className="icon sm"><use href={auto.appPassword ? '#i-alert' : '#i-check'} /></svg>
                    <span>
                      {auto.label
                        ? rich(t('acct.import.detected', { host: auto.imapHost }), { provider: <b>{auto.label}</b> })
                        : rich(t('acct.import.server'), { host: <b>{auto.imapHost}</b> })}
                      {discovering && <> · {t('acct.import.searching')}</>}
                      {found && !discovering && (
                        <>
                          {' '}· {found.source}
                          {' · '}
                          {found.verified ? t('acct.import.serverResponded') : t('acct.import.serverUnreachable')}
                        </>
                      )}
                      {auto.appPassword && (
                        <><br />{rich(t('acct.import.appPasswordNeeded'), { appPassword: <b>{t('acct.import.appPassword')}</b> })}</>
                      )}
                    </span>
                  </div>
                )}
                {canOAuth && (
                  <div className="oauth-connect">
                    {oauth.waiting ? (
                      <>
                        <span className="oauth-wait">{t('acct.import.oauthWaiting', { provider: OAUTH_LABEL[oauth.waiting] })}</span>
                        <button type="button" onClick={() => void oauth.retry().then((r) => r && setDone({ added: r.added ? 1 : 0, updated: r.added ? 0 : 1, skipped: 0 }))}>
                          {t('acct.common.reopenBrowser')}
                        </button>
                        <button type="button" onClick={oauth.cancel}>{t('action.cancel')}</button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="primary" onClick={() => void connectOAuth()} disabled={busy}>
                          {t('acct.import.connectWith', { provider: OAUTH_LABEL[oauthProvider!] })}
                        </button>
                        <span className="oauth-or">{t('acct.import.oauthRecommended')}</span>
                      </>
                    )}
                  </div>
                )}
                {oauthProvider && oauthReady && !oauthReady[oauthProvider] && (
                  <div className="oauth-or">
                    {t('acct.import.oauthNotConfigured', { provider: OAUTH_LABEL[oauthProvider] })}
                  </div>
                )}
                <button type="button" className="link-btn" onClick={() => setAdvanced((v) => !v)}>
                  <svg className={`icon sm chev ${advanced ? 'open' : ''}`}><use href="#i-chevron" /></svg>
                  {t('acct.import.advanced')}
                </button>
                {advanced && (
                  <>
                    <div className="cc-row">
                      <label>{t('acct.import.imapServer')}<input value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder={auto?.imapHost ?? t('acct.import.auto')} /></label>
                      <label className="port-label">{t('acct.server.port')}<input value={imapPort} onChange={(e) => setImapPort(e.target.value)} placeholder={String(auto?.imapPort ?? 993)} /></label>
                    </div>
                    <div className="cc-row">
                      <label>{t('acct.import.smtpServer')}<input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder={auto?.smtpHost ?? t('acct.import.auto')} /></label>
                      <label className="port-label">{t('acct.server.port')}<input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder={String(auto?.smtpPort ?? 465)} /></label>
                    </div>
                  </>
                )}
                <div className="modal-foot">
                  <button onClick={() => setImportOpen(false)}>{t('action.cancel')}</button>
                  <button className="primary" disabled={!email.trim() || !password || busy} onClick={() => void previewManual()}>
                    {busy ? t('acct.import.checking') : t('action.next')}
                  </button>
                </div>
              </>
            )}

            {mode === 'file' && (
              <>
                <p>
                  {rich(t('acct.import.fileIntro'), { mobileconfig: <b>.mobileconfig</b>, csv: <b>CSV</b> })}
                  <br />
                  <small>{t('acct.import.csvColumns')}</small>
                </p>
                <label className="filepick">
                  {busy ? t('acct.import.reading') : t('acct.import.pickFile')}
                  <input
                    type="file"
                    accept=".mobileconfig,.csv"
                    hidden
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void pickFile(f)
                    }}
                  />
                </label>
                <div className="modal-foot">
                  <button onClick={() => setImportOpen(false)}>{t('action.close')}</button>
                </div>
              </>
            )}
          </>
        )}

        {preview && !done && (
          <>
            <div className="import-table">
              <table>
                <thead>
                  <tr>
                    <th>{t('acct.common.email')}</th>
                    <th>IMAP</th>
                    <th>SMTP</th>
                    <th>{t('acct.common.password')}</th>
                    <th>{t('acct.import.colStatus')}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.map((r) => (
                    <tr key={r.email} className={!r.hasPassword ? 'dim' : ''}>
                      <td>{r.email}</td>
                      <td>{r.imapHost}:{r.imapPort}</td>
                      <td>{r.smtpHost}:{r.smtpPort}</td>
                      <td>
                        {r.hasPassword ? (
                          <svg className="icon sm"><use href="#i-check" /></svg>
                        ) : (
                          <><svg className="icon sm"><use href="#i-x" /></svg> {t('acct.import.noPassword')}</>
                        )}
                      </td>
                      <td title={r.exists ? t('acct.import.existsTip') : undefined}>{r.exists ? t('acct.import.passwordOnly') : t('acct.import.newAccount')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="modal-foot">
              <span>{t(mode === 'manual' ? 'acct.import.willAdd' : 'acct.import.willImport', { count: importable })}</span>
              <button onClick={() => setPreview(null)}>{t('action.back')}</button>
              <button className="primary" disabled={!importable || busy} onClick={() => void runImport()}>
                {busy ? t('acct.import.adding') : mode === 'manual' ? t('action.add') : t('acct.import.importAction')}
              </button>
            </div>
          </>
        )}

        {done && (
          <>
            <p>
              {rich(t('acct.import.doneAdded', { count: done.added }), { added: <b>{done.added}</b> })}
              {done.updated ? `, ${t('acct.import.doneUpdated', { count: done.updated })}` : ''}
              {done.skipped ? `, ${t('acct.import.doneSkipped', { count: done.skipped })}` : ''}. {t('acct.import.doneSyncing')}
            </p>
            {srcPath && (
              <p className="warn">
                <svg className="icon sm"><use href="#i-alert" /></svg>{' '}
                {rich(t('acct.import.securityNote'), { delete: <b>{t('acct.import.securityDelete')}</b> })}
                {!trashed && (
                  <button
                    onClick={() => {
                      void platform.trashFile(srcPath).then((ok) => {
                        if (ok) setTrashed(true)
                        else toast(t('acct.import.trashFailed'))
                      })
                    }}
                  >
                    <svg className="icon sm"><use href="#i-trash" /></svg> {t('acct.import.trashFile')}
                  </button>
                )}
                {trashed && <b> <svg className="icon sm"><use href="#i-check" /></svg> {t('acct.import.trashed')}</b>}
              </p>
            )}
            <div className="modal-foot">
              <button className="primary" onClick={() => setImportOpen(false)}>{t('acct.import.finish')}</button>
            </div>
          </>
        )}
    </Modal>
  )
}
