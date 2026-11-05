// Ayarlar › Sunucu filtreleri: hesap başına durum ve eylemler. Görme izni olan durumu görür, düğmeler yalnız
// yönetebilene çıkar. Yetki asıl olarak sunucuda (assertCanManage); burada yalnız arayüz sadeliği.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AccountInfo } from '../../../shared/rpc'
import type { SieveAccountInfo } from '../../../shared/sieve'
import { fmtDateTime, t } from '../../../shared/i18n'
import { canManageAccount } from '../moveDrag'
import { rpc } from '../rpcClient'
import { deployNote, detailLine, sieveActions, stateHintKey, stateLabelKey, stateTone } from '../sieveView'
import { useStore } from '../store'
import Modal from './Modal'
import SieveLeaveDialog, { isSieveUnreachable } from './SieveLeaveDialog'
import SieveScriptEditor from './SieveScriptEditor'
import SieveVacationSettings from './SieveVacationSettings'

function ConsentDialog({ script, busy, onCancel, onConfirm }: { script: string; busy: boolean; onCancel(): void; onConfirm(): void }) {
  return createPortal(
    <Modal onClose={onCancel} className="sieve-dialog">
      <div className="modal-title">{t('set.sieve.consent.title')}</div>
      <p className="sieve-note">{t('set.sieve.consent.active', { script })}</p>
      <p className="sieve-note">{t('set.sieve.consent.body')}</p>
      <div className="modal-foot">
        <button autoFocus onClick={onCancel}>{t('action.cancel')}</button>
        <button className="primary" onClick={onConfirm} disabled={busy}>{t('set.sieve.consent.confirm')}</button>
      </div>
    </Modal>,
    document.body
  )
}

function EndpointForm({ info, busy, onSave }: { info: SieveAccountInfo; busy: boolean; onSave(host: string | null, port: number | null): void }) {
  const [host, setHost] = useState(info.customHost ?? '')
  const [port, setPort] = useState(String(info.port))
  return (
    <details className="sieve-endpoint">
      <summary>{t('set.sieve.endpoint')}</summary>
      <div className="sieve-endpoint-row">
        <label>
          {t('set.sieve.host')}
          <input value={host} placeholder={info.host} onChange={(e) => setHost(e.target.value)} autoCapitalize="off" spellCheck={false} />
        </label>
        <label>
          {t('set.sieve.port')}
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </label>
        <button disabled={busy} onClick={() => onSave(host.trim() || null, Number(port))}>{t('action.save')}</button>
      </div>
    </details>
  )
}

function AccountRow({ account, info, manage, admin, busy, run, onConsent, onEditor, onVacation, onEndpoint }: {
  account: AccountInfo
  info: SieveAccountInfo
  manage: boolean
  admin: boolean
  busy: boolean
  run(accountId: number, call: () => Promise<SieveAccountInfo>): void
  onConsent(script: string): void
  onEditor(): void
  onVacation(): void
  onEndpoint(accountId: number, host: string | null, port: number | null): void
}) {
  const a = sieveActions(info)
  const id = account.id
  const note = deployNote(info)
  const hint = stateHintKey(info.state)
  const detail = detailLine(info)
  return (
    <div className="sieve-row" data-testid="sieve-account">
      <div className="sieve-head">
        <b className="sieve-email">{account.email}</b>
        <span className={`sieve-state ${stateTone(info.state)}`} data-testid="sieve-state">{t(stateLabelKey(info.state))}</span>
      </div>
      {note && <small className="sieve-meta">{t(note.key, note.at === undefined ? {} : { time: fmtDateTime(note.at) })}</small>}
      {hint && <small className="sieve-meta">{t(hint)}</small>}
      {detail.key && <small className="sieve-meta sieve-warn" data-testid="sieve-detail">{t(detail.key)}</small>}
      {detail.raw && <small className="sieve-meta err-text" data-testid="sieve-detail">{detail.raw}</small>}
      {manage && (
        <div className="sieve-actions">
          {a.enable && <button disabled={busy} onClick={() => run(id, () => rpc.call('sieveSetEnabled', { accountId: id, enabled: true }))}>{t('set.sieve.enable')}</button>}
          {a.consent && <button className="primary" disabled={busy} onClick={() => onConsent(a.consent!)}>{t('set.sieve.consent.open')}</button>}
          {a.reactivate && <button className="primary" disabled={busy} onClick={() => run(id, () => rpc.call('sieveConsent', { accountId: id, scriptName: '' }))}>{t('set.sieve.reactivate')}</button>}
          {a.redeploy && <button disabled={busy} onClick={() => run(id, () => rpc.call('sieveDeployNow', { accountId: id }))}>{t('set.sieve.redeploy')}</button>}
          {a.retry && <button disabled={busy} onClick={() => run(id, () => rpc.call('sieveDetect', { accountId: id, force: true }))}>{t('set.sieve.retry')}</button>}
          {a.editor && <button disabled={busy} onClick={onEditor}>{t('set.sieve.scripts')}</button>}
          {a.vacation && <button disabled={busy} onClick={onVacation}>{t('set.sieve.vacation')}</button>}
          {a.rollback && <button className="danger" disabled={busy} onClick={() => run(id, () => rpc.call('sieveRollback', { accountId: id }))}>{t('set.sieve.rollback')}</button>}
        </div>
      )}
      {admin && (
        <EndpointForm
          key={`${info.host}:${info.port}`}
          info={info}
          busy={busy}
          onSave={(host, port) => onEndpoint(id, host, port)}
        />
      )}
    </div>
  )
}

export default function SieveSettings() {
  const accounts = useStore((s) => s.accounts)
  const currentUser = useStore((s) => s.currentUser)
  const toast = useStore((s) => s.toast)
  const [infos, setInfos] = useState<Map<number, SieveAccountInfo> | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [bulk, setBulk] = useState(false)
  const [consent, setConsent] = useState<{ accountId: number; script: string } | null>(null)
  const [editor, setEditor] = useState<number | null>(null)
  const [vacation, setVacation] = useState<number | null>(null)
  const [leave, setLeave] = useState<{ accountId: number; host: string | null; port: number | null } | null>(null)
  const detected = useRef(false)

  const put = useCallback((i: SieveAccountInfo) => setInfos((m) => new Map(m).set(i.accountId, i)), [])

  const canManage = useCallback((id: number) => canManageAccount(currentUser, accounts.find((a) => a.id === id)), [currentUser, accounts])

  const load = useCallback((): void => {
    void rpc.call('listSieveAccounts', {}).then(
      async (list) => {
        setInfos(new Map(list.map((i) => [i.accountId, i])))
        setLoadFailed(false)
        if (detected.current) return
        detected.current = true
        // K13: yoklama tembel ve sıralı, sonuç ana makine başına önbellekte
        for (const i of list) {
          if (i.state !== 'unknown' || !canManage(i.accountId)) continue
          await rpc.call('sieveDetect', { accountId: i.accountId }).then(put, () => {})
        }
      },
      () => setLoadFailed(true)
    )
  }, [canManage, put])

  useEffect(load, [load])
  useEffect(
    () => rpc.on('sieve:state', ({ accountId }) => void rpc.call('getSieveAccount', { accountId }).then(put, () => {})),
    [put]
  )

  const run = useCallback(
    async (accountId: number, call: () => Promise<SieveAccountInfo>): Promise<SieveAccountInfo | null> => {
      setBusy((b) => new Set(b).add(accountId))
      try {
        const i = await call()
        put(i)
        return i
      } catch (e) {
        toast(String((e as Error).message))
        return null
      } finally {
        setBusy((b) => {
          const n = new Set(b)
          n.delete(accountId)
          return n
        })
      }
    },
    [put, toast]
  )

  const runRow = (accountId: number, call: () => Promise<SieveAccountInfo>): void => {
    void run(accountId, call).then((i) => {
      if (i?.consentNeededFor) setConsent({ accountId, script: i.consentNeededFor })
    })
  }

  // eski sunucu ulaşılamazsa ret, yöneticiye "betik orada kalacak" onayı olarak döner
  const saveEndpoint = (accountId: number, host: string | null, port: number | null, abandon: boolean): void => {
    setBusy((b) => new Set(b).add(accountId))
    rpc.call('sieveSetEndpoint', { accountId, host, port, ...(abandon ? { abandon: true } : {}) }).then(
      (i) => {
        put(i)
        if (i.left) toast(t('set.sieve.leave.done'), 'info')
      },
      (e: unknown) => {
        if (!abandon && isSieveUnreachable(e)) setLeave({ accountId, host, port })
        else toast(String((e as Error).message))
      }
    ).finally(() =>
      setBusy((b) => {
        const n = new Set(b)
        n.delete(accountId)
        return n
      })
    )
  }

  if (loadFailed) return <div className="empty-note">{t('set.sieve.loadFailed')}</div>
  if (!infos) return <div className="empty-note">{t('set.sieve.loading')}</div>

  const rows = accounts.filter((a) => infos.has(a.id))
  const eligible = rows.filter((a) => canManage(a.id) && sieveActions(infos.get(a.id)!).enable && infos.get(a.id)!.caps !== null)

  const enableAll = async (): Promise<void> => {
    setBulk(true)
    // tek tek: her hesabın login'i governor'dan geçer, sınıra takılan bekler (K1)
    for (const a of eligible) await run(a.id, () => rpc.call('sieveSetEnabled', { accountId: a.id, enabled: true }))
    setBulk(false)
  }

  return (
    <div data-testid="sieve-settings">
      <p className="sieve-note">{t('set.sieve.intro')}</p>
      <p className="sieve-note">{t('set.sieve.watchedHelp')}</p>
      {eligible.length > 0 && (
        <div className="settings-actions">
          <button disabled={bulk} onClick={() => void enableAll()}>{t('set.sieve.enableAll', { count: eligible.length })}</button>
        </div>
      )}
      {rows.map((a) => (
        <AccountRow
          key={a.id}
          account={a}
          info={infos.get(a.id)!}
          manage={canManage(a.id)}
          admin={currentUser?.role === 'admin'}
          busy={bulk || busy.has(a.id)}
          run={runRow}
          onConsent={(script) => setConsent({ accountId: a.id, script })}
          onEditor={() => setEditor(a.id)}
          onVacation={() => setVacation(a.id)}
          onEndpoint={(id, host, port) => saveEndpoint(id, host, port, false)}
        />
      ))}
      {!rows.length && <div className="empty-note">{t('set.sieve.empty')}</div>}
      {consent && (
        <ConsentDialog
          script={consent.script}
          busy={busy.has(consent.accountId)}
          onCancel={() => setConsent(null)}
          onConfirm={() => {
            const { accountId, script } = consent
            setConsent(null)
            void run(accountId, () => rpc.call('sieveConsent', { accountId, scriptName: script }))
          }}
        />
      )}
      {leave && (
        <SieveLeaveDialog
          busy={busy.has(leave.accountId)}
          onCancel={() => setLeave(null)}
          onConfirm={() => {
            const { accountId, host, port } = leave
            setLeave(null)
            saveEndpoint(accountId, host, port, true)
          }}
        />
      )}
      {editor !== null && <SieveScriptEditor accountId={editor} onClose={() => setEditor(null)} />}
      {vacation !== null && infos.get(vacation) && <SieveVacationSettings info={infos.get(vacation)!} onClose={() => setVacation(null)} onSaved={put} />}
    </div>
  )
}
