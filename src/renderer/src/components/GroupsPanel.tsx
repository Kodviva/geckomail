import { useEffect } from 'react'
import { useStore } from '../store'
import Modal from './Modal'
import { t } from '../../../shared/i18n'

export default function GroupsPanel() {
  const groups = useStore((s) => s.groups)
  const refreshGroups = useStore((s) => s.refreshGroups)
  const setGroupsOpen = useStore((s) => s.setGroupsOpen)
  const setEditGroup = useStore((s) => s.setEditGroup)

  useEffect(() => {
    void refreshGroups()
  }, [refreshGroups])

  return (
    <Modal onClose={() => setGroupsOpen(false)} className="groups">
        <div className="modal-title">{t('acct.common.groups')}</div>
        <div className="user-list">
          {groups.map((g) => (
            <div key={g.id} className="user-row">
              <span className="group-swatch" style={{ background: g.color }} />
              <div className="user-info">
                <div className="user-name">{g.name}</div>
                <small>{t('acct.group.accountCount', { count: g.accountCount })}</small>
              </div>
              <button type="button" className="btn user-edit" onClick={() => setEditGroup(g.id)}>
                <svg className="icon sm"><use href="#i-pencil" /></svg> {t('action.edit')}
              </button>
            </div>
          ))}
          {!groups.length && <div className="empty-note">{t('acct.group.empty')}</div>}
        </div>
        <div className="modal-foot">
          <button className="primary" onClick={() => setEditGroup('new')}>
            <svg className="icon sm"><use href="#i-plus" /></svg> {t('acct.group.add')}
          </button>
          <button onClick={() => setGroupsOpen(false)}>{t('action.close')}</button>
        </div>
    </Modal>
  )
}
