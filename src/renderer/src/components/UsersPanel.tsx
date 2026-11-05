import { useEffect } from 'react'
import { useStore } from '../store'
import Modal from './Modal'
import { fmtDateTime, t } from '../../../shared/i18n'

export default function UsersPanel() {
  const users = useStore((s) => s.users)
  const refreshUsers = useStore((s) => s.refreshUsers)
  const setUsersOpen = useStore((s) => s.setUsersOpen)
  const setEditUser = useStore((s) => s.setEditUser)

  useEffect(() => {
    void refreshUsers()
  }, [refreshUsers])

  return (
    <Modal onClose={() => setUsersOpen(false)} className="users">
        <div className="modal-title">{t('acct.common.users')}</div>
        <div className="user-list">
          {users.map((u) => (
            <div key={u.id} className={`user-row ${u.enabled ? '' : 'disabled'}`}>
              <div className={`user-avatar ${u.role === 'admin' ? 'admin' : 'member'}`}>{u.username.charAt(0).toUpperCase()}</div>
              <div className="user-info">
                <div className="user-name">
                  {u.username}
                  <span className={`role-pill ${u.role === 'admin' ? 'admin' : 'member'}`}>{u.role === 'admin' ? t('acct.role.admin') : t('acct.role.member')}</span>
                  {!u.enabled && <span className="role-pill off">{t('acct.status.disabled')}</span>}
                </div>
                <small>{u.lastLoginAt ? t('acct.users.lastLogin', { when: fmtDateTime(u.lastLoginAt) }) : t('acct.users.neverLoggedIn')}</small>
              </div>
              <button type="button" className="btn user-edit" onClick={() => setEditUser(u.id)}>
                <svg className="icon sm"><use href="#i-pencil" /></svg> {t('action.edit')}
              </button>
            </div>
          ))}
          {!users.length && <div className="empty-note">{t('acct.users.empty')}</div>}
        </div>
        <div className="modal-foot">
          <button className="primary" onClick={() => setEditUser('new')}>
            <svg className="icon sm"><use href="#i-plus" /></svg> {t('acct.users.add')}
          </button>
          <button onClick={() => setUsersOpen(false)}>{t('action.close')}</button>
        </div>
    </Modal>
  )
}
