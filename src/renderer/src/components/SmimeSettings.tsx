// Ayarlar › Kasa: S/MIME sertifikaları. Özel anahtar arayüze hiç gelmez; dışa aktarma motorda parolalı .p12 üretir.
// Parolalar yalnız bu bileşenin durumundadır: işlem bitince boşaltılır, panel kapanınca bileşenle gider.
import { useCallback, useEffect, useState } from 'react'
import type { RpcMethods } from '../../../shared/rpc'
import { SMIME_P12_MAX_BYTES, smimeBadges, type SmimeContactCertInfo, type SmimeIdentityInfo } from '../../../shared/smime'
import { fmtDate, t } from '../../../shared/i18n'
import { canManageAccount } from '../moveDrag'
import { platform } from '../platform'
import { rpc } from '../rpcClient'
import { useStore } from '../store'

type TrustInfo = ReturnType<RpcMethods['smimeTrustInfo']>

const MIN_EXPORT_PASSWORD = 12

function toBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function ChainBadge({ i }: { i: SmimeIdentityInfo }) {
  const [b] = smimeBadges({ sig: i.chainState, enc: 'none', notes: [], signer: null, canSaveCert: false })
  return b ? <span className={`smime-badge static ${b.tone}`}>{t(b.labelKey)}</span> : null
}

function ImportForm({ onDone }: { onDone: () => void }) {
  const toast = useStore((s) => s.toast)
  const accounts = useStore((s) => s.accounts)
  const currentUser = useStore((s) => s.currentUser)
  const own = accounts.filter((a) => canManageAccount(currentUser, a))
  const [accountId, setAccountId] = useState<number | null>(own[0]?.id ?? null)
  const [file, setFile] = useState<File | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const chosen = accountId ?? own[0]?.id ?? null
  const submit = async (): Promise<void> => {
    if (!file || chosen == null) return
    if (file.size > SMIME_P12_MAX_BYTES) return toast(t('sync.smime.p12TooLarge'), 'error')
    setBusy(true)
    try {
      await rpc.call('smimeImportIdentity', { accountId: chosen, p12Base64: toBase64(await file.arrayBuffer()), password })
      setFile(null)
      toast(t('smime.set.imported'), 'info')
      onDone()
    } catch (e) {
      toast(String((e as Error).message), 'error')
    } finally {
      setPassword('')
      setBusy(false)
    }
  }
  return (
    <div className="set-field set-field-col smime-form">
      <div className="sf-t">{t('smime.set.import')}</div>
      <label>{t('smime.set.account')}
        <select value={chosen ?? ''} onChange={(e) => setAccountId(Number(e.target.value))} disabled={busy}>
          {own.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
        </select>
      </label>
      <label>{t('smime.set.file')}
        <input type="file" accept=".p12,.pfx,application/x-pkcs12" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label>{t('smime.set.p12Password')}
        <input type="password" autoComplete="off" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button type="button" className="primary" disabled={busy || !file || chosen == null} onClick={() => void submit()}>{t('smime.set.importAction')}</button>
    </div>
  )
}

function ExportForm({ i, onClose }: { i: SmimeIdentityInfo; onClose: () => void }) {
  const toast = useStore((s) => s.toast)
  const [vaultPassphrase, setVaultPassphrase] = useState('')
  const [pass1, setPass1] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)
  const valid = !!vaultPassphrase && pass1.length >= MIN_EXPORT_PASSWORD && pass1 === pass2
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const { filename, base64 } = await rpc.call('smimeExportIdentity', { id: i.id, vaultPassphrase, exportPassword: pass1 })
      await platform.saveBytes(filename, Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)))
      onClose()
    } catch (e) {
      toast(String((e as Error).message), 'error')
    } finally {
      setVaultPassphrase('')
      setPass1('')
      setPass2('')
      setBusy(false)
    }
  }
  return (
    <div className="smime-form">
      <label>{t('smime.set.vaultPassword')}
        <input type="password" autoComplete="off" value={vaultPassphrase} disabled={busy} onChange={(e) => setVaultPassphrase(e.target.value)} />
      </label>
      <label>{t('smime.set.exportPassword', { min: MIN_EXPORT_PASSWORD })}
        <input type="password" autoComplete="off" value={pass1} disabled={busy} onChange={(e) => setPass1(e.target.value)} />
      </label>
      <label>{t('smime.set.exportPasswordAgain')}
        <input type="password" autoComplete="off" value={pass2} disabled={busy} onChange={(e) => setPass2(e.target.value)} />
      </label>
      <div className="chip-row">
        <button type="button" className="primary" disabled={busy || !valid} onClick={() => void submit()}>{t('smime.set.exportAction')}</button>
        <button type="button" disabled={busy} onClick={onClose}>{t('action.cancel')}</button>
      </div>
    </div>
  )
}

function RemoveForm({ i, onClose, onDone }: { i: SmimeIdentityInfo; onClose: () => void; onDone: () => void }) {
  const toast = useStore((s) => s.toast)
  const [confirmEmail, setConfirmEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await rpc.call('smimeRemoveIdentity', { id: i.id, confirmEmail })
      onDone()
    } catch (e) {
      toast(String((e as Error).message), 'error')
      setBusy(false)
    }
  }
  return (
    <div className="smime-form">
      <p className="smime-warn">{t('smime.set.removeWarning')}</p>
      <label>{t('smime.set.removeType', { email: i.email })}
        <input autoComplete="off" value={confirmEmail} disabled={busy} onChange={(e) => setConfirmEmail(e.target.value)} />
      </label>
      <div className="chip-row">
        <button type="button" className="danger" disabled={busy || !confirmEmail} onClick={() => void submit()}>{t('action.remove')}</button>
        <button type="button" disabled={busy} onClick={onClose}>{t('action.cancel')}</button>
      </div>
    </div>
  )
}

/** Yönetici parolanızı sıfırladıysa: uyarı ancak kendi parolanızla kapanır */
function PasswordChange({ onDone }: { onDone: () => void }) {
  const toast = useStore((s) => s.toast)
  const [currentPassword, setCurrent] = useState('')
  const [newPassword, setNew] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await rpc.call('changeOwnPassword', { currentPassword, newPassword })
      toast(t('smime.set.passwordChanged'), 'info')
      onDone()
    } catch (e) {
      toast(String((e as Error).message), 'error')
    } finally {
      setCurrent('')
      setNew('')
      setBusy(false)
    }
  }
  return (
    <div className="set-group" data-testid="smime-password">
      <div className="set-field set-field-col smime-form">
        <div className="sf-t">{t('smime.set.changePassword')}</div>
        <label>{t('smime.set.currentPassword')}
          <input type="password" autoComplete="current-password" value={currentPassword} disabled={busy} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label>{t('smime.set.newPassword')}
          <input type="password" autoComplete="new-password" value={newPassword} disabled={busy} onChange={(e) => setNew(e.target.value)} />
        </label>
        <button type="button" className="primary" disabled={busy || !currentPassword || newPassword.length < 8} onClick={() => void submit()}>{t('smime.set.changePassword')}</button>
      </div>
    </div>
  )
}

function AdminTrust() {
  const toast = useStore((s) => s.toast)
  const [info, setInfo] = useState<TrustInfo | null>(null)
  const [crl, setCrl] = useState(true)
  const [label, setLabel] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = useCallback((): void => {
    void rpc.call('smimeTrustInfo', {}).then(setInfo, (e: Error) => toast(e.message, 'error'))
  }, [toast])
  useEffect(() => {
    refresh()
    void rpc.call('getPrefs', {}).then((p) => setCrl(p.smimeRevocation !== 'off'), () => {})
  }, [refresh])
  const add = async (): Promise<void> => {
    if (!file) return
    setBusy(true)
    try {
      const data = await file.arrayBuffer()
      const text = new TextDecoder().decode(data)
      await rpc.call('smimeAddAnchor', { pemOrDerBase64: text.includes('-----BEGIN') ? text : toBase64(data), label })
      setFile(null)
      setLabel('')
      refresh()
    } catch (e) {
      toast(String((e as Error).message), 'error')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (fingerprint: string): Promise<void> => {
    try {
      await rpc.call('smimeRemoveAnchor', { fingerprint })
      refresh()
    } catch (e) {
      toast(String((e as Error).message), 'error')
    }
  }
  return (
    <div className="set-group" data-testid="smime-trust">
      <div className="set-field">
        <div className="sf-l">
          <div className="sf-t">{t('smime.set.trustTitle')}</div>
          {info && <div className="sf-h">{t('smime.set.trustInfo', { count: info.count, date: info.fetchedAt.slice(0, 10) })}</div>}
        </div>
      </div>
      <div className="set-field">
        <div className="sf-l"><div className="sf-t">{t('smime.set.crl')}</div><div className="sf-h">{t('smime.set.crlHint')}</div></div>
        <div className="sf-c">
          <input
            type="checkbox"
            aria-label={t('smime.set.crl')}
            checked={crl}
            onChange={(e) => {
              setCrl(e.target.checked)
              void rpc.call('setPrefs', { values: { smimeRevocation: e.target.checked ? 'crl' : 'off' } }).catch((err: Error) => toast(err.message, 'error'))
            }}
          />
        </div>
      </div>
      {info?.anchors.map((a) => (
        <div key={a.fingerprint} className="set-field">
          <div className="sf-l"><div className="sf-t">{a.label}</div><div className="sf-h">{a.subject} · {fmtDate(a.notAfter)}</div></div>
          <div className="sf-c"><button type="button" onClick={() => void remove(a.fingerprint)}>{t('action.remove')}</button></div>
        </div>
      ))}
      <div className="set-field set-field-col smime-form">
        <div className="sf-t">{t('smime.set.anchorAdd')}</div>
        <label>{t('smime.set.anchorLabel')}
          <input value={label} disabled={busy} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label>{t('smime.set.anchorFile')}
          <input type="file" accept=".pem,.crt,.cer,.der" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <button type="button" disabled={busy || !file || !label.trim()} onClick={() => void add()}>{t('smime.set.anchorAddAction')}</button>
      </div>
    </div>
  )
}

export default function SmimeSettings({ isAdmin }: { isAdmin: boolean }) {
  const toast = useStore((s) => s.toast)
  const vaultState = useStore((s) => s.vaultState)
  const [ids, setIds] = useState<SmimeIdentityInfo[] | null>(null)
  const [contacts, setContacts] = useState<SmimeContactCertInfo[]>([])
  const [open, setOpen] = useState<{ id: number; form: 'export' | 'remove' } | null>(null)
  const [mustChange, setMustChange] = useState(false)
  const refresh = useCallback((): void => {
    void rpc.call('smimeListIdentities', {}).then(setIds, (e: Error) => toast(e.message, 'error'))
    void rpc.call('smimeListContactCerts', {}).then(setContacts, () => {})
  }, [toast])
  useEffect(() => refresh(), [refresh])
  useEffect(() => {
    void rpc.call('getSecurityNotice', {}).then((n) => setMustChange(n.mustChangePassword), () => {})
  }, [])
  const removeContact = async (id: number): Promise<void> => {
    try {
      await rpc.call('smimeRemoveContactCert', { id })
      refresh()
    } catch (e) {
      toast(String((e as Error).message), 'error')
    }
  }
  return (
    <>
      {mustChange && <PasswordChange onDone={() => setMustChange(false)} />}
      <div className="set-group" data-testid="smime-identities">
        <div className="set-field">
          <div className="sf-l">
            <div className="sf-t">{t('smime.set.mine')}</div>
            <div className="sf-h">{t('smime.set.mineHint')}</div>
          </div>
        </div>
        {ids?.map((i) => (
          <div key={i.id} className="set-field set-field-col">
            <div className="smime-cert-row">
              <div className="sf-l">
                <div className="sf-t">{i.email}</div>
                <div className="sf-h">{i.issuer} · {t('smime.set.expires', { date: fmtDate(i.notAfter) })}</div>
              </div>
              <ChainBadge i={i} />
              <button type="button" onClick={() => setOpen({ id: i.id, form: 'export' })}>{t('smime.set.export')}</button>
              <button type="button" className="danger" onClick={() => setOpen({ id: i.id, form: 'remove' })}>{t('action.remove')}</button>
            </div>
            {open?.id === i.id && open.form === 'export' && <ExportForm i={i} onClose={() => setOpen(null)} />}
            {open?.id === i.id && open.form === 'remove' && <RemoveForm i={i} onClose={() => setOpen(null)} onDone={() => { setOpen(null); refresh() }} />}
          </div>
        ))}
        {vaultState === 'unlocked' ? (
          <ImportForm onDone={refresh} />
        ) : (
          <div className="set-field"><div className="sf-h">{t(vaultState === 'none' ? 'sync.smime.vaultNone' : 'sync.smime.vaultLocked')}</div></div>
        )}
      </div>
      <div className="set-group" data-testid="smime-contacts">
        <div className="set-field"><div className="sf-l"><div className="sf-t">{t('smime.set.contacts')}</div><div className="sf-h">{t('smime.set.contactsHint')}</div></div></div>
        {contacts.map((c) => (
          <div key={c.id} className="set-field">
            <div className="sf-l"><div className="sf-t">{c.email}</div><div className="sf-h">{c.subject} · {t('smime.set.expires', { date: fmtDate(c.notAfter) })}</div></div>
            {!platform.native && <div className="sf-c"><button type="button" onClick={() => void removeContact(c.id)}>{t('action.remove')}</button></div>}
          </div>
        ))}
      </div>
      {isAdmin && <AdminTrust />}
      <div className="set-group">
        <div className="set-field"><div className="sf-h">{t('smime.set.searchNote')}</div></div>
        <div className="set-field"><div className="sf-h">{t('smime.set.keyNote')}</div></div>
      </div>
    </>
  )
}
