import { useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import Modal from './Modal'
import { t } from '../../../shared/i18n'

export default function GroupEdit() {
  const editGroupId = useStore((s) => s.editGroupId)
  const setEditGroup = useStore((s) => s.setEditGroup)
  const groups = useStore((s) => s.groups)
  const accounts = useStore((s) => s.accounts)
  const refreshGroups = useStore((s) => s.refreshGroups)
  const refreshAccounts = useStore((s) => s.refreshAccounts)
  const toast = useStore((s) => s.toast)

  const isNew = editGroupId === 'new'
  const existing = !isNew ? groups.find((g) => g.id === editGroupId) : undefined

  const [acctQuery, setAcctQuery] = useState('')
  const [onlyThis, setOnlyThis] = useState(false)
  const [name, setName] = useState(existing?.name ?? '')
  const [color, setColor] = useState(existing?.color ?? '#8d7ba6')
  const [busy, setBusy] = useState(false)

  if (!isNew && !existing) return null

  const save = async () => {
    if (!name.trim()) {
      toast(t('acct.group.nameEmpty'), 'error')
      return
    }
    setBusy(true)
    try {
      if (isNew) {
        const created = await rpc.call('createGroup', { name: name.trim(), color })
        await refreshGroups()
        toast(t('acct.group.created'), 'info')
        setEditGroup(created.id) // aynı modalda hesap ataması yapılabilsin
      } else if (existing) {
        await rpc.call('updateGroup', { groupId: existing.id, patch: { name: name.trim(), color } })
        await refreshGroups()
        toast(t('acct.group.updated'), 'info')
        setEditGroup(null)
      }
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!existing) return
    if (!window.confirm(t('acct.group.confirmDelete', { name: existing.name, count: existing.accountCount })))
      return
    try {
      await rpc.call('deleteGroup', { groupId: existing.id })
      await refreshGroups()
      await refreshAccounts()
      toast(t('acct.group.deleted'), 'info')
      setEditGroup(null)
    } catch (e) {
      toast(String((e as Error).message))
    }
  }

  const setAccountGroup = (accountId: number, checked: boolean) => {
    if (!existing) return
    void rpc
      .call('setAccountGroup', { accountId, groupId: checked ? existing.id : null })
      .then(() => Promise.all([refreshAccounts(), refreshGroups()]))
      .catch((e) => toast(String((e as Error).message)))
  }

  return (
    <Modal onClose={() => setEditGroup(null)} className="groups" confirmOnDirty>
        <div className="modal-title">{isNew ? t('acct.group.new') : existing!.name}</div>
        <div className="cc-row">
          <label>
            {t('acct.group.name')}
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label className="color-label">
            {t('acct.common.color')}
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
          </label>
        </div>
        {!isNew && existing && (
          <>
            <label>{t('acct.group.accounts', { total: existing.accountCount })}</label>
            <div className="cc-row">
              <input value={acctQuery} onChange={(e) => setAcctQuery(e.target.value)} placeholder={t('acct.group.searchPlaceholder')} aria-label={t('acct.common.searchAccounts')} />
              <label className="check-label">
                <input type="checkbox" checked={onlyThis} onChange={(e) => setOnlyThis(e.target.checked)} />
                {t('acct.group.onlyThis')}
              </label>
            </div>
            <div className="acct-list group-acct-list">
              {accounts
                .filter((a) => !onlyThis || a.groupId === existing.id)
                .filter((a) => !acctQuery.trim() || `${a.email} ${a.displayName ?? ''}`.toLowerCase().includes(acctQuery.trim().toLowerCase()))
                .map((a) => {
                const inThisGroup = a.groupId === existing.id
                const elsewhere = !inThisGroup && a.groupId != null ? groups.find((g) => g.id === a.groupId)?.name : null
                return (
                  <div key={a.id} className={`acct-row ${elsewhere ? 'disabled' : ''}`}>
                    <input type="checkbox" checked={inThisGroup} onChange={(e) => setAccountGroup(a.id, e.target.checked)} />
                    <span className="acct-color" style={{ background: a.color }} />
                    <span className="acct-name">{a.email}</span>
                    {elsewhere && <small>{t('acct.group.currently', { group: elsewhere })}</small>}
                  </div>
                )
              })}
            </div>
          </>
        )}
        <div className="modal-foot">
          {!isNew && existing && (
            <button className="danger" onClick={() => void remove()}>
              {t('acct.group.delete')}
            </button>
          )}
          <span />
          <button onClick={() => setEditGroup(null)}>{t('action.cancel')}</button>
          <button className="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
            {isNew ? t('acct.common.create') : t('action.save')}
          </button>
        </div>
    </Modal>
  )
}
