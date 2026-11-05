// Ayarlar › Kasa (yalnız tarayıcı): kullanıcının açık oturumları. Bildirimini kapatan telefon cihaz listesinden çıkar, oturumu burada görünür.
import { useCallback, useEffect, useState } from 'react'
import type { RpcMethods } from '../../../shared/rpc'
import { fmtDateTime, t } from '../../../shared/i18n'
import { rpc } from '../rpcClient'
import { useStore } from '../store'

type Session = ReturnType<RpcMethods['listSessions']>[number]

export function SessionRows({ list, busy, onRevoke }: { list: Session[]; busy: boolean; onRevoke(id: string): void }) {
  return (
    <>
      {list.map((s) => (
        <div className="set-field" key={s.id}>
          <div className="sf-l">
            <div className="sf-t">{s.label}{s.current ? ` · ${t('set.sessions.current')}` : ''}</div>
            <div className="sf-h">{t(s.kind === 'mobile' ? 'set.sessions.mobile' : 'set.sessions.web')} · {t('set.sessions.lastSeen', { at: fmtDateTime(s.lastSeenAt) })}</div>
          </div>
          {!s.current && (
            <div className="sf-c">
              <button type="button" aria-label={`${t('set.sessions.revoke')}: ${s.label}`} disabled={busy} onClick={() => onRevoke(s.id)}>{t('set.sessions.revoke')}</button>
            </div>
          )}
        </div>
      ))}
    </>
  )
}

export default function SessionsSettings() {
  const toast = useStore((st) => st.toast)
  const [list, setList] = useState<Session[]>([])
  const [busy, setBusy] = useState(false)
  const refresh = useCallback(() => {
    void rpc.call('listSessions', {}).then(setList, () => toast(t('set.sessions.failed'), 'error'))
  }, [toast])
  useEffect(() => refresh(), [refresh])
  const run = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await work()
    } catch {
      toast(t('set.sessions.failed'), 'error')
    } finally {
      setBusy(false)
      refresh()
    }
  }
  return (
    <div className="set-group" data-testid="sessions">
      <div className="set-field">
        <div className="sf-l"><div className="sf-t">{t('set.sessions.title')}</div><div className="sf-h">{t('set.sessions.hint')}</div></div>
        {list.length > 1 && (
          <div className="sf-c"><button type="button" className="danger" disabled={busy} onClick={() => void run(() => rpc.call('revokeOtherSessions', {}))}>{t('set.sessions.revokeOthers')}</button></div>
        )}
      </div>
      <SessionRows list={list} busy={busy} onRevoke={(id) => void run(() => rpc.call('revokeSession', { id }))} />
    </div>
  )
}
