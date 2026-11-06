import { useCallback, useEffect, useState } from 'react'
import type { AccountServerSettings, TlsMode } from '../../../shared/rpc'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { attention, fmtRelative, statusLabel } from '../accountHealth'
import Modal from './Modal'
import SieveLeaveDialog, { isSieveUnreachable } from './SieveLeaveDialog'
import { OAUTH_LABEL, PIM_TOAST, useOAuthConnect } from './useOAuthConnect'
import { fmtDateTime, t } from '../../../shared/i18n'
import { rich } from '../rich'
import { adminUi } from '../adminUi'

// yalnız anahtarlar modül düzeyinde; metin çağrı anında çevrilir
const STATUS_TEXT_KEY: Record<string, string> = {
  auth_failed: 'acct.edit.statusAuthFailed',
  unreachable: 'acct.edit.statusUnreachable',
  degraded: 'acct.edit.statusDegraded',
  unknown: 'acct.edit.statusUnknown'
}
const statusText = (s: string): string => (Object.prototype.hasOwnProperty.call(STATUS_TEXT_KEY, s) ? t(STATUS_TEXT_KEY[s]) : s)


// güvenlik türü değişince port varsayılanın karşılığıysa onu da çevir (özel portlara dokunma)
const DEFAULT_PORT = { imap: { tls: 993, starttls: 143 }, smtp: { tls: 465, starttls: 587 } } as const

export default function AccountEdit() {
  const editAccountId = useStore((s) => s.editAccountId)
  const setEditAccount = useStore((s) => s.setEditAccount)
  const accounts = useStore((s) => s.accounts)
  const refreshAccounts = useStore((s) => s.refreshAccounts)
  const refreshList = useStore((s) => s.refreshList)
  const toast = useStore((s) => s.toast)
  const vaultState = useStore((s) => s.vaultState)
  const setAccountSecure = useStore((s) => s.setAccountSecure)
  const createVault = useStore((s) => s.createVault)
  const setVaultPromptOpen = useStore((s) => s.setVaultPromptOpen)
  const acc = accounts.find((a) => a.id === editAccountId)
  const oauth = useOAuthConnect()
  const [oauthClients, setOauthClients] = useState<{ google: boolean; microsoft: boolean } | null>(null)
  const [pimLinked, setPimLinked] = useState(false)
  const [pimBusy, setPimBusy] = useState(false)
  const refreshPim = useCallback((): void => {
    void rpc.call('listPimSources', {}).then((list) => setPimLinked(list.some((p) => p.accountId === editAccountId)), () => {})
  }, [editAccountId])
  useEffect(refreshPim, [refreshPim])
  useEffect(() => {
    void rpc.call('oauthGetClients', {}).then((c) => setOauthClients({ google: c.googleReady, microsoft: c.microsoftReady })).catch(() => {})
  }, [])
  const oauthOf = (authType: string | undefined) =>
    authType === 'oauth:google' ? 'google' : authType === 'oauth:microsoft' ? 'microsoft' : null
  // şifreli Gmail/Outlook hesabı: OAuth'a geçiş öner (istemci tanımlıysa)
  const domain = acc?.email.split('@')[1]?.toLowerCase() ?? ''
  const suggestedProvider =
    acc && !oauthOf(acc.authType)
      ? /^(gmail|googlemail)\.com$/.test(domain)
        ? ('google' as const)
        : /^(outlook|hotmail|live|msn)\./.test(domain)
          ? ('microsoft' as const)
          : null
      : null
  const oauthSuggest = suggestedProvider && oauthClients?.[suggestedProvider] ? suggestedProvider : null
  const [displayName, setDisplayName] = useState(acc?.displayName ?? '')
  const [color, setColor] = useState(acc?.color ?? '#b6924f')
  const [signature, setSignature] = useState(acc?.signature ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [newVaultPw, setNewVaultPw] = useState('')
  const [newVaultPw2, setNewVaultPw2] = useState('')
  const [showCreateVault, setShowCreateVault] = useState(false)
  const [serverOpen, setServerOpen] = useState(false)
  const [serverOrig, setServerOrig] = useState<AccountServerSettings | null>(null)
  const [server, setServer] = useState<AccountServerSettings | null>(null)
  const need = acc ? attention(acc) : null
  const [historyOpen, setHistoryOpen] = useState(false)
  const [leaveAsk, setLeaveAsk] = useState(false)
  const currentUser = useStore((s) => s.currentUser)
  const groups = useStore((s) => s.groups)
  const refreshGroups = useStore((s) => s.refreshGroups)
  const toggleStar = useStore((s) => s.toggleStar)
  const [groupId, setGroupId] = useState<number | null>(acc?.groupId ?? null)
  // kaydet sonrası canlı doğrulama: önce 'unknown'a düşmeyi (retryAccount), sonra sonucu bekle
  const [verify, setVerify] = useState<{ start: number; reset: boolean } | null>(null)
  const isAdmin = adminUi(currentUser)
  const connectPim = async (): Promise<void> => {
    if (!acc) return
    const provider = oauthOf(acc.authType)
    if (provider) {
      await oauth.connect(provider, { email: acc.email, accountId: acc.id, pim: true })
      refreshPim()
      return
    }
    setPimBusy(true)
    try {
      let { status, host } = await rpc.call('connectAccountPim', { accountId: acc.id })
      // sunucu posta düzeninin dışında: parola ancak kullanıcı adı görüp onaylarsa gider
      if (status === 'confirmHost' && host && window.confirm(t('pim.connect.confirmHost', { host }))) ({ status, host } = await rpc.call('connectAccountPim', { accountId: acc.id, confirmedHost: host }))
      toast(t(PIM_TOAST[status]), status === 'connected' ? 'info' : undefined)
      refreshPim()
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setPimBusy(false)
    }
  }
  useEffect(() => {
    if (isAdmin && !groups.length) void refreshGroups()
  }, [isAdmin, groups.length, refreshGroups])
  useEffect(() => {
    if (verify && !verify.reset && acc && (acc.status === 'unknown' || (acc.lastSuccessAt ?? 0) >= verify.start)) {
      setVerify({ ...verify, reset: true })
    }
  }, [acc, verify])
  const [history, setHistory] = useState<{ ts: number; status: string; detail: string | null }[] | null>(null)

  // sunucuya ulaşılamıyorsa sunucu bölümü açık gelsin (sorunun büyük olasılıkla orada)
  useEffect(() => {
    if (need !== 'server' || !acc) return
    void rpc
      .call('getAccountServer', { accountId: acc.id })
      .then((s) => {
        setServerOrig(s)
        setServer(s)
        setServerOpen(true)
      })
      .catch(() => {})
    // yalnızca açılışta
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bilinçli: yalnız açılışta / belirtilen değişkenlerle
  }, [])

  if (!acc) return null

  const toggleServer = async () => {
    if (!serverOpen && !server) {
      try {
        const s = await rpc.call('getAccountServer', { accountId: acc.id })
        setServerOrig(s)
        setServer(s)
      } catch (e) {
        toast(String((e as Error).message))
        return
      }
    }
    setServerOpen((v) => !v)
  }

  const setTls = (proto: 'imap' | 'smtp', mode: TlsMode) => {
    if (!server) return
    const portKey = proto === 'imap' ? 'imapPort' : 'smtpPort'
    const tlsKey = proto === 'imap' ? 'imapTls' : 'smtpTls'
    const prev = server[tlsKey]
    const port = server[portKey] === DEFAULT_PORT[proto][prev] ? DEFAULT_PORT[proto][mode] : server[portKey]
    setServer({ ...server, [tlsKey]: mode, [portKey]: port })
  }

  // yalnızca değişen sunucu alanları gönderilir
  const serverPatch = (): Partial<AccountServerSettings> => {
    if (!server || !serverOrig) return {}
    const out: Partial<AccountServerSettings> = {}
    for (const k of Object.keys(server) as (keyof AccountServerSettings)[]) {
      if (server[k] !== serverOrig[k]) (out as Record<string, unknown>)[k] = server[k]
    }
    return out
  }

  const toggleSecure = async () => {
    if (!acc.secure) {
      // canlı→kasa
      if (vaultState === 'unlocked') {
        setBusy(true)
        try {
          await setAccountSecure(acc.id, true)
          setEditAccount(null)
        } catch {
          /* toast setAccountSecure içinde */
        } finally {
          setBusy(false)
        }
      } else if (vaultState === 'locked') {
        toast(t('acct.edit.openVaultFirst'), 'error')
        setVaultPromptOpen(true)
      } else {
        setShowCreateVault(true) // henüz kasa yok → parola belirlet
      }
    } else {
      // kasa→canlı (vault açık olmalı)
      if (vaultState !== 'unlocked') {
        toast(t('acct.edit.openVaultFirst'), 'error')
        setVaultPromptOpen(true)
        return
      }
      setBusy(true)
      try {
        await setAccountSecure(acc.id, false)
        setEditAccount(null)
      } catch {
        /* toast içeride */
      } finally {
        setBusy(false)
      }
    }
  }

  const createVaultAndSecure = async () => {
    if (newVaultPw.length < 8) return toast(t('acct.edit.vaultPasswordTooShort'), 'error')
    if (newVaultPw !== newVaultPw2) return toast(t('acct.edit.vaultPasswordsMismatch'), 'error')
    setBusy(true)
    try {
      const ok = await createVault(newVaultPw)
      if (ok) {
        await setAccountSecure(acc.id, true)
        setEditAccount(null)
      }
    } catch {
      /* toast içeride */
    } finally {
      setBusy(false)
    }
  }

  const save = async (abandonSieve = false) => {
    setBusy(true)
    try {
      const res = await rpc.call('updateAccount', {
        accountId: acc.id,
        patch: {
          displayName: displayName.trim() || null,
          color,
          signature: signature.trim() || null,
          ...serverPatch(),
          ...(password ? { password } : {})
        },
        ...(abandonSieve ? { abandonSieve: true } : {})
      })
      if (res?.sieveLeft) toast(t('set.sieve.leave.done'), 'info')
      if (isAdmin && groupId !== (acc.groupId ?? null)) await rpc.call('setAccountGroup', { accountId: acc.id, groupId })
      await refreshAccounts()
      const connChanged = !!password || Object.keys(serverPatch()).length > 0
      if (connChanged) {
        // form açık kalır: bağlantı sonucunu burada göster (kullanıcı ayrıca noktayı izlemek zorunda kalmasın)
        setPassword('')
        setServerOrig(server)
        setVerify({ start: Date.now(), reset: false })
      } else {
        toast(t('acct.edit.updated'), 'info')
        setEditAccount(null)
      }
    } catch (e) {
      // eski Sieve sunucusuna ulaşılamıyor: yalnız yönetici betiğin orada kalmasını onaylayabilir
      if (!abandonSieve && isAdmin && isSieveUnreachable(e)) setLeaveAsk(true)
      else toast(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const toggleEnabled = async () => {
    try {
      await rpc.call('setAccountEnabled', { accountId: acc.id, enabled: !acc.enabled })
      await refreshAccounts()
    } catch (e) {
      toast(String((e as Error).message))
    }
  }

  // doğrulama sonucu: sıfırlandıktan sonra başarı ya da yeni hata
  const verifyResult = (() => {
    if (!verify) return null
    if ((acc.lastSuccessAt ?? 0) >= verify.start) return { kind: 'ok' as const, text: t('acct.edit.verifyOk') }
    if (verify.reset && acc.status !== 'unknown') {
      const k = attention(acc)
      if (k === 'auth') return { kind: 'bad' as const, text: t('acct.edit.verifyAuth') }
      if (k === 'server' || acc.status === 'degraded') return { kind: 'bad' as const, text: t('acct.edit.verifyFailed', { detail: acc.statusDetail ?? t('acct.edit.unknownError') }) }
    }
    return { kind: 'wait' as const, text: t('acct.edit.verifyWait') }
  })()

  const remove = async () => {
    // K24: sunucudaki kurallar en iyi çabayla geri alınır, kullanıcı bunu önceden bilmeli
    const sieveOn = await rpc.call('getSieveAccount', { accountId: acc.id }).then((i) => i.enabled, () => false)
    const warning = sieveOn ? `\n\n${t('set.sieve.deleteWarning')}` : ''
    if (!window.confirm(t('acct.edit.confirmRemove', { email: acc.email }) + warning))
      return
    setBusy(true)
    try {
      await rpc.call('deleteAccount', { accountId: acc.id })
      await refreshAccounts()
      await refreshList(true)
      toast(t('acct.edit.removed'), 'info')
      setEditAccount(null)
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal onClose={() => setEditAccount(null)} className="account-edit" confirmOnDirty={!verify}>
        <div className="modal-title">{acc.email}</div>
        {acc.status !== 'ok' && acc.enabled && (
          <div className={`acct-status-banner ${need === 'auth' || need === 'server' ? 'bad' : ''}`} role="status">
            <b>{statusText(acc.status)}</b>
            {acc.statusDetail && <span>{acc.statusDetail}</span>}
            {need === 'auth' && <span>{t('acct.edit.authHint')}</span>}
            {need === 'server' && <span>{t('acct.edit.serverHint')}</span>}
          </div>
        )}
        {verifyResult && (
          <div className={`verify-row ${verifyResult.kind}`} role="status" aria-live="polite">
            {verifyResult.text}
          </div>
        )}
        <div className="cc-row">
          <label>
            {t('acct.edit.displayName')}
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder={t('acct.edit.displayNamePlaceholder')} />
          </label>
          <label className="color-label">
            {t('acct.common.color')}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
        </div>
        <div className="cc-row">
          {isAdmin && (
            <label>
              {t('acct.common.group')}
              <select value={groupId ?? ''} onChange={(e) => setGroupId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{t('acct.common.noGroupOption')}</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="check-label notify-toggle">
            <input type="checkbox" checked={acc.starred} onChange={() => toggleStar(acc.id)} />
            {t('acct.edit.notifyStarred')}
          </label>
        </div>
        {(oauthOf(acc.authType) ? isAdmin : isAdmin || (acc.groupId != null && currentUser?.manageableGroupIds.includes(acc.groupId))) && !acc.secure && (
          <div className="oauth-connect">
            <span className="oauth-or">{t(pimLinked ? 'pim.acct.linked' : 'pim.acct.hint')}</span>
            {!oauth.waiting && !pimLinked && (
              <button type="button" disabled={pimBusy} onClick={() => void connectPim()}>
                {t('pim.acct.connect')}
              </button>
            )}
          </div>
        )}
        <label>
          {t('acct.edit.signature')}
          <textarea rows={4} value={signature} onChange={(e) => setSignature(e.target.value)} placeholder={t('acct.edit.signaturePlaceholder')} />
        </label>
        {oauthOf(acc.authType) ? (
          <div className="oauth-connect">
            <span className="oauth-or">
              {rich(t('acct.edit.oauthLinked'), { provider: <b>{OAUTH_LABEL[oauthOf(acc.authType)!]}</b> })}
              {need === 'auth' && ` ${t('acct.edit.oauthExpired')}`}
            </span>
            {oauth.waiting ? (
              <>
                <button type="button" onClick={() => void oauth.retry()}>{t('acct.common.reopenBrowser')}</button>
                <button type="button" onClick={oauth.cancel}>{t('action.cancel')}</button>
              </>
            ) : (
              // kişi ve takvim bağlıysa yeni belirteç o kapsamları da taşımalı
              <button type="button" className={need === 'auth' ? 'primary' : ''} onClick={() => void oauth.connect(oauthOf(acc.authType)!, { email: acc.email, accountId: acc.id, pim: pimLinked })}>
                {t('acct.edit.reauthorize')}
              </button>
            )}
          </div>
        ) : (
          <>
            <label>
              {t('acct.edit.newPassword')}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus={need === 'auth'}
                placeholder={need === 'auth' ? t('acct.edit.newPasswordPlaceholder') : ''}
              />
            </label>
            {oauthSuggest && (
              <div className="oauth-connect">
                <span className="oauth-or">
                  {t('acct.edit.oauthSuggest', { provider: OAUTH_LABEL[oauthSuggest] })}
                </span>
                {oauth.waiting ? (
                  <>
                <button type="button" onClick={() => void oauth.retry()}>{t('acct.common.reopenBrowser')}</button>
                <button type="button" onClick={oauth.cancel}>{t('action.cancel')}</button>
              </>
                ) : (
                  <button type="button" onClick={() => void oauth.connect(oauthSuggest, { email: acc.email, accountId: acc.id })}>
                    {t('acct.edit.connectWith', { provider: OAUTH_LABEL[oauthSuggest] })}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {isAdmin && (
          <button type="button" className="link-btn" onClick={() => void toggleServer()}>
            <svg className={`icon sm chev ${serverOpen ? 'open' : ''}`}><use href="#i-chevron" /></svg>
            {t('acct.edit.serverToggle')}
          </button>
        )}
        {serverOpen && server && (
          <div className="server-section">
            <div className="cc-row">
              <label>
                {t('acct.server.imapHost')}
                <input value={server.imapHost} onChange={(e) => setServer({ ...server, imapHost: e.target.value })} spellCheck={false} />
              </label>
              <label className="port-label">
                {t('acct.server.port')}
                <input type="number" value={server.imapPort} onChange={(e) => setServer({ ...server, imapPort: Number(e.target.value) })} />
              </label>
              <label className="tls-label">
                {t('acct.server.security')}
                <select value={server.imapTls} onChange={(e) => setTls('imap', e.target.value as TlsMode)}>
                  <option value="tls">SSL/TLS</option>
                  <option value="starttls">STARTTLS</option>
                </select>
              </label>
            </div>
            <div className="cc-row">
              <label>
                {t('acct.server.smtpHost')}
                <input value={server.smtpHost} onChange={(e) => setServer({ ...server, smtpHost: e.target.value })} spellCheck={false} />
              </label>
              <label className="port-label">
                {t('acct.server.port')}
                <input type="number" value={server.smtpPort} onChange={(e) => setServer({ ...server, smtpPort: Number(e.target.value) })} />
              </label>
              <label className="tls-label">
                {t('acct.server.security')}
                <select value={server.smtpTls} onChange={(e) => setTls('smtp', e.target.value as TlsMode)}>
                  <option value="tls">SSL/TLS</option>
                  <option value="starttls">STARTTLS</option>
                </select>
              </label>
            </div>
            <label className="check-label">
              <input
                type="checkbox"
                checked={server.allowInvalidCerts}
                onChange={(e) => setServer({ ...server, allowInvalidCerts: e.target.checked })}
              />
              {t('acct.edit.allowInvalidCerts')}
            </label>
          </div>
        )}

        <button
          type="button"
          className="link-btn"
          onClick={() => {
            if (!history) void rpc.call('getAccountStatusHistory', { accountId: acc.id }).then(setHistory).catch(() => setHistory([]))
            setHistoryOpen((v) => !v)
          }}
        >
          <svg className={`icon sm chev ${historyOpen ? 'open' : ''}`}><use href="#i-chevron" /></svg>
          {acc.lastSuccessAt ? t('acct.edit.historyLastSync', { when: fmtRelative(acc.lastSuccessAt) }) : t('acct.edit.history')}
        </button>
        {historyOpen && (
          <div className="status-history">
            {!history && <span className="auth-hint">{t('state.loading')}</span>}
            {history && !history.length && <span className="auth-hint">{t('acct.edit.historyEmpty')}</span>}
            {history?.map((h, i) => (
              <div key={i} className="status-history-row">
                <span className="sh-time">{fmtDateTime(h.ts, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                <span className={`sh-status ${h.status}`}>{statusLabel(h.status)}</span>
                <span className="sh-detail">{h.detail ?? ''}</span>
              </div>
            ))}
          </div>
        )}

        <div className="vault-section">
          <div className="vault-section-head">
            <svg className="icon sm"><use href={acc.secure ? '#i-lock' : '#i-unlock'} /></svg>
            <b>{t('acct.edit.vaultMode')}</b>
            <span className={`vault-tag ${acc.secure ? 'on' : ''}`}>{acc.secure ? t('acct.edit.vaultOn') : t('acct.edit.vaultOff')}</span>
          </div>
          <p className="auth-hint">
            {acc.secure
              ? t('acct.edit.vaultOnHint')
              : t('acct.edit.vaultOffHint')}
          </p>
          {!showCreateVault ? (
            <button type="button" onClick={() => void toggleSecure()} disabled={busy}>
              {acc.secure ? t('acct.edit.removeFromVault') : t('acct.edit.addToVault')}
            </button>
          ) : (
            <div className="vault-create">
              <p className="auth-hint">{t('acct.edit.firstVaultHint')}</p>
              <input type="password" placeholder={t('acct.edit.vaultPasswordMin')} value={newVaultPw} onChange={(e) => setNewVaultPw(e.target.value)} autoComplete="new-password" />
              <input type="password" placeholder={t('acct.edit.vaultPasswordRepeat')} value={newVaultPw2} onChange={(e) => setNewVaultPw2(e.target.value)} autoComplete="new-password" />
              <div className="vault-create-foot">
                <button type="button" onClick={() => setShowCreateVault(false)} disabled={busy}>{t('action.cancel')}</button>
                <button type="button" className="primary" onClick={() => void createVaultAndSecure()} disabled={busy}>
                  {busy ? t('acct.common.creating') : t('acct.edit.createVaultAndAdd')}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="danger" onClick={() => void remove()} disabled={busy}>
            {t('acct.edit.removeAccount')}
          </button>
          <button onClick={() => void toggleEnabled()} disabled={busy} title={t('acct.edit.disabledTip')}>
            {acc.enabled ? t('acct.common.disable') : t('acct.common.enable')}
          </button>
          <span />
          <button onClick={() => setEditAccount(null)}>{verify ? t('action.close') : t('action.cancel')}</button>
          <button className="primary" onClick={() => void save()} disabled={busy}>
            {busy ? t('acct.edit.saving') : t('action.save')}
          </button>
        </div>
      {leaveAsk && (
        <SieveLeaveDialog
          busy={busy}
          onCancel={() => setLeaveAsk(false)}
          onConfirm={() => {
            setLeaveAsk(false)
            void save(true)
          }}
        />
      )}
    </Modal>
  )
}
