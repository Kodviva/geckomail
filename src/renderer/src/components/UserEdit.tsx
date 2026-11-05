import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import type { UserRole } from '../../../shared/rpc'
import Modal from './Modal'
import { t } from '../../../shared/i18n'

export default function UserEdit() {
  const editUserId = useStore((s) => s.editUserId)
  const setEditUser = useStore((s) => s.setEditUser)
  const users = useStore((s) => s.users)
  const groups = useStore((s) => s.groups)
  const refreshUsers = useStore((s) => s.refreshUsers)
  const refreshGroups = useStore((s) => s.refreshGroups)
  const currentUser = useStore((s) => s.currentUser)
  const toast = useStore((s) => s.toast)

  const isNew = editUserId === 'new'
  const existing = !isNew ? users.find((u) => u.id === editUserId) : undefined

  const [username, setUsername] = useState(existing?.username ?? '')
  const [role, setRole] = useState<UserRole>(existing?.role ?? 'member')
  const [enabled, setEnabled] = useState(existing?.enabled ?? true)
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [resetting, setResetting] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refreshGroups()
  }, [refreshGroups])

  if (!isNew && !existing) return null

  const permFor = (groupId: number) => existing?.permissions.find((p) => p.groupId === groupId) ?? { canView: false, canManage: false }

  const togglePerm = (groupId: number, field: 'canView' | 'canManage', value: boolean) => {
    if (!existing) return
    const cur = permFor(groupId)
    const next = { canView: field === 'canView' ? value : cur.canView, canManage: field === 'canManage' ? value : cur.canManage }
    void rpc
      .call('setGroupPermission', { userId: existing.id, groupId, canView: next.canView, canManage: next.canManage })
      .then(refreshUsers)
      .catch((e) => toast(String((e as Error).message)))
  }

  const save = async () => {
    setBusy(true)
    try {
      if (isNew) {
        const created = await rpc.call('createUser', { username: username.trim(), password, role })
        await refreshUsers()
        toast(t('acct.user.created'), 'info')
        setEditUser(created.id) // aynı modalda düzenlemeye geç — izinler hemen ayarlanabilsin
      } else if (existing) {
        await rpc.call('updateUser', { userId: existing.id, patch: { role, enabled } })
        await refreshUsers()
        toast(t('acct.user.updated'), 'info')
        setEditUser(null)
      }
    } catch (e) {
      toast(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const doResetPassword = async () => {
    if (!existing) return
    if (newPassword.length < 8) {
      toast(t('acct.user.passwordTooShort'), 'error')
      return
    }
    try {
      const { passkeysRemoved } = await rpc.call('resetUserPassword', { userId: existing.id, newPassword })
      toast(passkeysRemoved ? t('acct.user.passwordUpdatedPasskeys', { count: passkeysRemoved }) : t('acct.user.passwordUpdated'), 'info')
      setNewPassword('')
      setResetting(false)
    } catch (e) {
      toast(String((e as Error).message))
    }
  }

  const remove = async () => {
    if (!existing) return
    if (!window.confirm(t('acct.user.confirmDelete', { username: existing.username }))) return
    try {
      await rpc.call('deleteUser', { userId: existing.id })
      await refreshUsers()
      toast(t('acct.user.deleted'), 'info')
      setEditUser(null)
    } catch (e) {
      toast(String((e as Error).message))
    }
  }

  return (
    <Modal onClose={() => setEditUser(null)} confirmOnDirty>
        <div className="modal-title">{isNew ? t('acct.user.new') : existing!.username}</div>
        <div className="cc-row">
          <label>
            {t('acct.common.username')}
            <input value={username} onChange={(e) => setUsername(e.target.value)} disabled={!isNew} />
          </label>
          <label>
            {t('acct.user.role')}
            <select value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
              <option value="member">{t('acct.role.member')}</option>
              <option value="admin">{t('acct.role.admin')}</option>
            </select>
          </label>
        </div>
        {isNew && (
          <label>
            {t('acct.common.passwordMin8')}
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {!isNew && (
          <label className="check-row">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>{t('acct.user.enabledHint')}</span>
          </label>
        )}
        {!isNew && existing && (
          <>
            <label>
              {role === 'admin' ? (
                <span className="auth-hint">{t('acct.user.adminHint')}</span>
              ) : (
                t('acct.user.groupPermissions')
              )}
            </label>
            {role === 'member' && (
              <div className="import-table">
                <table>
                  <thead>
                    <tr>
                      <th>{t('acct.common.group')}</th>
                      <th>{t('acct.user.permView')}</th>
                      <th>{t('acct.user.permManage')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const p = permFor(g.id)
                      return (
                        <tr key={g.id}>
                          <td>
                            <span className="acct-color" style={{ background: g.color }} /> {g.name}
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={p.canView}
                              onChange={(e) => togglePerm(g.id, 'canView', e.target.checked)}
                            />
                          </td>
                          <td>
                            <input
                              type="checkbox"
                              checked={p.canManage}
                              onChange={(e) => togglePerm(g.id, 'canManage', e.target.checked)}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <label>
              {t('acct.user.resetPassword')}
              {!resetting ? (
                <button type="button" onClick={() => setResetting(true)}>
                  {t('acct.user.changePassword')}
                </button>
              ) : (
                <div className="cc-row">
                  <input
                    type="password"
                    placeholder={t('acct.user.newPasswordPlaceholder')}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                  <button type="button" onClick={() => void doResetPassword()}>
                    {t('acct.user.update')}
                  </button>
                </div>
              )}
            </label>
          </>
        )}
        <div className="modal-foot">
          {!isNew && existing && existing.id !== currentUser?.id && (
            <button className="danger" onClick={() => void remove()}>
              {t('acct.user.delete')}
            </button>
          )}
          <span />
          <button onClick={() => setEditUser(null)}>{t('action.cancel')}</button>
          <button className="primary" onClick={() => void save()} disabled={busy || (isNew && (!username.trim() || password.length < 8))}>
            {isNew ? t('acct.common.create') : t('action.save')}
          </button>
        </div>
    </Modal>
  )
}
