// Ayarlar › Sunucu (R17/R32): mail sunucusu yönetimi — bağlantı, IP engelleri, izinli IP'ler, hesap uyumu.
// Sunucu türü otomatik algılanır (şu an Stalwart). Anahtar sync sürecinde şifreli saklanır; bu ekran yalnız var/yok bilgisini görür.
import { useEffect, useState } from 'react'
import type { ServerAdminConfig, ServerAllowedIp, ServerBlockedIp } from '../../../shared/rpc'
import { rpc } from '../rpcClient'
import { useStore } from '../store'
import { fmtDateTime, t } from '../../../shared/i18n'

type Tab = 'baglanti' | 'engel' | 'izin' | 'uyum'

const KEY_FILE = '~/.config/geckomail/server-admin.key'
const REASON_KEYS = new Set(['portScanning', 'authFailure', 'loiter', 'manual', 'rateLimit'])

function reasonLabel(r: string | null | undefined): string {
  if (!r) return '—'
  return REASON_KEYS.has(r) ? t(`set.server.reason.${r}`) : r
}

function fmt(ts: string | null): string {
  if (!ts) return '—'
  return fmtDateTime(new Date(ts), { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function ServerAdminPanel() {
  const toast = useStore((s) => s.toast)
  const [tab, setTab] = useState<Tab>('baglanti')
  const [cfg, setCfg] = useState<ServerAdminConfig | null>(null)
  const [url, setUrl] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const [blocked, setBlocked] = useState<{ total: number; items: ServerBlockedIp[] } | null>(null)
  const [blockedQuery, setBlockedQuery] = useState('')
  const [allowed, setAllowed] = useState<ServerAllowedIp[] | null>(null)
  const [allowAddr, setAllowAddr] = useState('')
  const [allowHours, setAllowHours] = useState(24)
  const [allowReason, setAllowReason] = useState('')
  const [diff, setDiff] = useState<{ onServerNotInApp: string[]; inAppNotOnServer: string[]; serverTotal: number } | null>(null)

  const run = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true)
    try {
      const r = await fn()
      if (ok) toast(ok, 'info')
      return r
    } catch (e) {
      toast((e as Error).message)
      return undefined
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    void rpc.call('serverAdminGetConfig', {}).then((c) => {
      setCfg(c)
      setUrl(c.url)
    })
  }, [])

  const loadBlocked = () => run(async () => setBlocked(await rpc.call('serverAdminBlocked', { address: blockedQuery || undefined })))
  const loadAllowed = () => run(async () => setAllowed(await rpc.call('serverAdminAllowed', {})))
  const loadDiff = () => run(async () => setDiff(await rpc.call('serverAdminAccountDiff', {})))

  useEffect(() => {
    if (!cfg?.hasKey) return
    if (tab === 'engel' && !blocked) void loadBlocked()
    if (tab === 'izin' && !allowed) void loadAllowed()
    if (tab === 'uyum' && !diff) void loadDiff()
    // sekmeye ilk girişte bir kez
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bilinçli: yalnız sekme/anahtar değişince
  }, [tab, cfg?.hasKey])

  const save = async (importKeyFile: boolean) => {
    const c = await run(() => rpc.call('serverAdminSetConfig', { url, key: key || undefined, importKeyFile }), t('set.server.saved'))
    if (c) {
      setCfg(c)
      setKey('')
      void test()
    }
  }
  const test = async () => {
    const r = await run(() => rpc.call('serverAdminTest', {}))
    if (r) setStatus(t('set.server.connected', { provider: r.provider, user: r.username, count: r.principals }))
  }

  const unblock = async (item: ServerBlockedIp) => {
    const note = cfg?.provider === 'Stalwart' ? `\n\n${t('set.server.stalwartUnblockNote')}` : ''
    if (!window.confirm(t('set.server.unblockConfirm', { address: item.address }) + note)) return
    const r = await run(() => rpc.call('serverAdminUnblock', { ids: [item.id] }), t('set.server.unblocked'))
    if (r) void loadBlocked()
  }

  const addAllowed = async () => {
    const perm = allowHours === 0
    if (perm && !window.confirm(t('set.server.permanentConfirm', { address: allowAddr }))) return
    const r = await run(() => rpc.call('serverAdminAllow', { address: allowAddr, hours: allowHours, reason: allowReason }), t('set.server.allowAdded'))
    if (r) {
      setAllowAddr('')
      setAllowReason('')
      void loadAllowed()
    }
  }

  const removeAllowed = async (item: ServerAllowedIp) => {
    if (!window.confirm(t('set.server.removeAllowedConfirm', { address: item.address }))) return
    const r = await run(() => rpc.call('serverAdminRemoveAllowed', { ids: [item.id] }), t('set.server.allowRemoved'))
    if (r) void loadAllowed()
  }

  if (!cfg) return <div className="empty-note">{t('state.loading')}</div>

  return (
    <div className="server-admin">
      <div className="segmented fill" role="tablist" aria-label={t('set.server.tabsAria')}>
        {(
          [
            ['baglanti', t('set.server.tabConnection')],
            ['engel', t('set.server.tabBlocked')],
            ['izin', t('set.server.tabAllowed')],
            ['uyum', t('set.server.tabAccounts')]
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)} disabled={id !== 'baglanti' && !cfg.hasKey}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'baglanti' && (
        <div className="set-group">
          <div className="set-field">
            <div className="sf-l">
              <div className="sf-t">{t('set.server.url')}</div>
              <div className="sf-h">
                {t('set.server.urlHint')}
                {cfg.suggested && ` ${t('set.server.urlSuggested')}`}
                {cfg.provider && ` ${t('set.server.detected', { provider: cfg.provider })}`}
              </div>
            </div>
            <div className="sf-c">
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mail.example.com" spellCheck={false} style={{ minWidth: 240 }} aria-label={t('set.server.url')} />
            </div>
          </div>
          <div className="set-field">
            <div className="sf-l">
              <div className="sf-t">{t('set.server.apiKey')} {cfg.hasKey ? <span className="subs-tag ok">{t('set.server.keyStored')}</span> : <span className="subs-tag dim">{t('set.server.keyNone')}</span>}</div>
              <div className="sf-h">
                {t('set.server.keyHint')}
                {cfg.keyFileExists && ` ${t('set.server.keyFileFound', { path: KEY_FILE })}`}
              </div>
            </div>
            <div className="sf-c">
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={cfg.hasKey ? t('set.server.newKeyPlaceholder') : t('set.server.keyPlaceholder')}
                autoComplete="off"
                aria-label={t('set.server.apiKey')}
                style={{ minWidth: 180 }}
              />
            </div>
          </div>
          <div className="set-field">
            <div className="sf-l">
              <div className="sf-t">{t('set.server.status')}</div>
              <div className="sf-h">{status ?? (cfg.hasKey ? t('set.server.testPrompt') : t('set.server.noKey'))}</div>
            </div>
            <div className="sf-c">
              {cfg.keyFileExists && (
                <button type="button" onClick={() => void save(true)} disabled={busy} title={t('set.server.importTitle', { path: KEY_FILE })}>
                  {t('set.server.importBtn')}
                </button>
              )}
              <button type="button" className="primary" onClick={() => void save(false)} disabled={busy || !url.trim() || (!key && url === cfg.url && !cfg.suggested)}>
                {t('set.server.saveAndTest')}
              </button>
              {cfg.hasKey && (
                <>
                  <button type="button" onClick={() => void test()} disabled={busy}>{t('set.server.test')}</button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(t('set.server.clearKeyConfirm')))
                        void run(() => rpc.call('serverAdminClearKey', {}), t('set.server.keyCleared')).then((c) => c && setCfg(c))
                    }}
                  >
                    {t('set.server.clearKey')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'engel' && (
        <>
          <div className="server-toolbar">
            <input
              value={blockedQuery}
              onChange={(e) => setBlockedQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void loadBlocked()}
              placeholder={t('set.server.searchPlaceholder')}
              aria-label={t('set.server.searchAria')}
              spellCheck={false}
            />
            <button type="button" onClick={() => void loadBlocked()} disabled={busy}>
              {t('action.search')}
            </button>
            <span className="server-count">{blocked
                ? t('set.server.blockedCount', { count: blocked.total }) +
                  (blocked.items.length < blocked.total ? ` · ${t('set.server.showingFirst', { count: blocked.items.length })}` : '')
                : ''}</span>
          </div>
          {blocked && blocked.total > 0 && blocked.items.every((b) => !b.expiresAt) && (
            <div className="server-note">
              {t('set.server.noExpiryNote', { where: cfg.provider === 'Stalwart' ? ' (Stalwart › Settings › Security)' : '' })}
            </div>
          )}
          <div className="server-list" role="list">
            {blocked?.items.map((b) => (
              <div key={b.id} className="server-row" role="listitem">
                <span className="server-addr">{b.address}</span>
                <span className="server-reason">{reasonLabel(b.reason)}</span>
                <span className="server-date" title={t('set.server.added')}>{fmt(b.createdAt)}</span>
                <span className="server-date" title={t('set.server.expires')}>{b.expiresAt ? `→ ${fmt(b.expiresAt)}` : t('set.server.permanent')}</span>
                <button type="button" className="sm" onClick={() => void unblock(b)} disabled={busy}>
                  {t('set.server.unblock')}
                </button>
              </div>
            ))}
            {blocked && !blocked.items.length && <div className="empty-note">{t('set.server.noMatch')}</div>}
          </div>
        </>
      )}

      {tab === 'izin' && (
        <>
          <div className="server-toolbar">
            <input value={allowAddr} onChange={(e) => setAllowAddr(e.target.value)} placeholder={t('set.server.allowPlaceholder')} aria-label={t('set.server.allowAria')} spellCheck={false} />
            <select value={allowHours} onChange={(e) => setAllowHours(Number(e.target.value))} aria-label={t('set.server.durationAria')}>
              <option value={1}>{t('set.server.hour1')}</option>
              <option value={24}>{t('set.server.day1')}</option>
              <option value={168}>{t('set.server.week1')}</option>
              <option value={720}>{t('set.server.days30')}</option>
              <option value={0}>{t('set.server.forever')}</option>
            </select>
            <input value={allowReason} onChange={(e) => setAllowReason(e.target.value)} placeholder={t('set.server.notePlaceholder')} aria-label={t('set.server.noteAria')} />
            <button type="button" className="primary" onClick={() => void addAllowed()} disabled={busy || !allowAddr.trim()}>
              {t('action.add')}
            </button>
          </div>
          <div className="server-note">{t('set.server.allowNote')}</div>
          <div className="server-list" role="list">
            {allowed?.map((a) => (
              <div key={a.id} className="server-row" role="listitem">
                <span className="server-addr">{a.address}</span>
                <span className="server-reason">{a.reason ?? '—'}</span>
                <span className="server-date" title={t('set.server.added')}>{fmt(a.createdAt)}</span>
                <span className={`server-date ${a.expiresAt ? '' : 'warn'}`} title={t('set.server.expires')}>{a.expiresAt ? `→ ${fmt(a.expiresAt)}` : t('set.server.permanent')}</span>
                <button type="button" className="sm danger" onClick={() => void removeAllowed(a)} disabled={busy}>
                  {t('set.server.removeAllowed')}
                </button>
              </div>
            ))}
            {allowed && !allowed.length && <div className="empty-note">{t('set.server.noAllowed')}</div>}
          </div>
        </>
      )}

      {tab === 'uyum' && (
        <>
          <div className="server-toolbar">
            <span className="server-count">{diff ? t('set.server.serverTotal', { count: diff.serverTotal }) : ''}</span>
            <button type="button" onClick={() => void loadDiff()} disabled={busy}>
              {t('action.refresh')}
            </button>
          </div>
          {diff && (
            <div className="server-diff">
              <div>
                <div className="ob-section">{t('set.server.onServerOnly', { count: diff.onServerNotInApp.length })}</div>
                {diff.onServerNotInApp.map((e) => (
                  <div key={e} className="server-row">
                    <span className="server-addr">{e}</span>
                  </div>
                ))}
                {!diff.onServerNotInApp.length && <div className="empty-note">{t('set.server.noneOk')}</div>}
              </div>
              <div>
                <div className="ob-section">{t('set.server.inAppOnly', { count: diff.inAppNotOnServer.length })}</div>
                {diff.inAppNotOnServer.map((e) => (
                  <div key={e} className="server-row">
                    <span className="server-addr">{e}</span>
                    <span className="server-reason warn">{t('set.server.inAppOnlyHint')}</span>
                  </div>
                ))}
                {!diff.inAppNotOnServer.length && <div className="empty-note">{t('set.server.noneOk')}</div>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
