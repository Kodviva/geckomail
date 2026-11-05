import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { decorateMenu, menuKeyNav } from '../menuNav'
import { t } from '../../../shared/i18n'
import { adminUi } from '../adminUi'

// Hesap listesi sağ-tık menüsü: bir hesap üzerinde (yıldızla/düzenle/yeniden-dene/devre-dışı) ya da
// "Tüm Gelen Kutuları" üzerinde (görünüm filtresi + tümünü-okundu).
export default function AccountContextMenu() {
  const menu = useStore((s) => s.accountMenu)
  const closeAccountMenu = useStore((s) => s.closeAccountMenu)
  const accounts = useStore((s) => s.accounts)
  const currentUser = useStore((s) => s.currentUser)
  const toggleStar = useStore((s) => s.toggleStar)
  const setEditAccount = useStore((s) => s.setEditAccount)
  const setFilter = useStore((s) => s.setAccountFilter)
  const setViewFilter = useStore((s) => s.setAccountViewFilter)
  const viewFilter = useStore((s) => s.accountViewFilter)
  const sort = useStore((s) => s.accountSort)
  const setSort = useStore((s) => s.setAccountSort)
  const markAllSeen = useStore((s) => s.markAllSeen)
  const refreshAccounts = useStore((s) => s.refreshAccounts)

  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  // ölç-sonra-yerleştir: menü her açılışta paint'ten önce yeniden konumlanır (kapalıyken pos kullanılmaz)
  useLayoutEffect(() => {
    if (!menu) return
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      x: Math.min(menu.x, Math.max(8, window.innerWidth - rect.width - 8)),
      y: Math.min(menu.y, Math.max(8, window.innerHeight - rect.height - 8))
    })
    el.focus()
    decorateMenu(el)
  }, [menu])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeAccountMenu()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [menu, closeAccountMenu])

  if (!menu) return null
  const close = (): void => closeAccountMenu()
  const run = (fn: () => void | Promise<void>): void => {
    void fn()
    close()
  }

  const isAll = menu.accountId === 'all'
  const acc = isAll ? null : accounts.find((a) => a.id === menu.accountId)
  if (!isAll && !acc) return null

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="ctx-menu"
      style={{ left: pos?.x ?? menu.x, top: pos?.y ?? menu.y, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (menuKeyNav(e, ref.current)) return
        if (e.key === 'Escape') {
          e.stopPropagation()
          close()
        }
      }}
    >
      {isAll ? (
        <>
          <div className="ctx-label">{t('acct.menu.filter')}</div>
          <div className={`ctx-item ${viewFilter === 'all' ? 'on' : ''}`} onClick={() => run(() => setViewFilter('all'))}>
            <svg className="icon sm"><use href="#i-inbox" /></svg> {t('acct.view.all')}
          </div>
          <div className={`ctx-item ${viewFilter === 'unread' ? 'on' : ''}`} onClick={() => run(() => setViewFilter('unread'))}>
            <svg className="icon sm"><use href="#i-inbox" /></svg> {t('acct.view.unread')}
          </div>
          <div className={`ctx-item ${viewFilter === 'starred' ? 'on' : ''}`} onClick={() => run(() => setViewFilter('starred'))}>
            <svg className="icon sm"><use href="#i-star" /></svg> {t('acct.menu.onlyStarred')}
          </div>
          <div className={`ctx-item ${viewFilter === 'problems' ? 'on' : ''}`} onClick={() => run(() => setViewFilter('problems'))}>
            <svg className="icon sm"><use href="#i-alert" /></svg> {t('acct.menu.onlyProblems')}
          </div>
          <div className="ctx-divider" />
          <div className="ctx-label">{t('acct.menu.sort')}</div>
          <div className={`ctx-item ${sort === 'unread' ? 'on' : ''}`} onClick={() => run(() => setSort('unread'))}>
            <svg className="icon sm"><use href="#i-inbox" /></svg> {t('acct.menu.unreadFirst')}
          </div>
          <div className={`ctx-item ${sort === 'starred' ? 'on' : ''}`} onClick={() => run(() => setSort('starred'))}>
            <svg className="icon sm"><use href="#i-star" /></svg> {t('acct.sort.starred')}
          </div>
          <div className={`ctx-item ${sort === 'name' ? 'on' : ''}`} onClick={() => run(() => setSort('name'))}>
            <svg className="icon sm"><use href="#i-check" /></svg> {t('acct.sort.name')}
          </div>
          <div className="ctx-divider" />
          <div className="ctx-item" onClick={() => run(() => markAllSeen())}>
            <svg className="icon sm"><use href="#i-check2" /></svg> {t('acct.menu.markAllRead')}
          </div>
        </>
      ) : acc ? (
        <>
          <div className="ctx-item" onClick={() => run(() => setFilter([acc.id]))}>
            <svg className="icon sm"><use href="#i-inbox" /></svg> {t('acct.menu.showOnly')}
          </div>
          <div className="ctx-item" onClick={() => run(() => toggleStar(acc.id))}>
            <svg className="icon sm"><use href="#i-star" /></svg> {acc.starred ? t('acct.menu.unstar') : t('acct.menu.star')}
          </div>
          <div className="ctx-item" onClick={() => run(() => setEditAccount(acc.id))}>
            <svg className="icon sm"><use href="#i-pencil" /></svg> {acc.status === 'auth_failed' ? t('acct.menu.updatePassword') : t('acct.menu.editAccount')}
          </div>
          {/* şifre hatalıyken yeniden denemek yalnızca bir başarısız login daha üretir (sunucu banı) */}
          {acc.status === 'unreachable' && (
            <div className="ctx-item" onClick={() => run(async () => { await rpc.call('retryAccount', { accountId: acc.id }); await refreshAccounts() })}>
              <svg className="icon sm"><use href="#i-refresh" /></svg> {t('action.retry')}
            </div>
          )}
          {adminUi(currentUser) && (
            <>
              <div className="ctx-divider" />
              <div className="ctx-item" onClick={() => run(async () => { await rpc.call('setAccountEnabled', { accountId: acc.id, enabled: !acc.enabled }); await refreshAccounts() })}>
                <svg className="icon sm"><use href="#i-power" /></svg> {acc.enabled ? t('acct.common.disable') : t('acct.common.enable')}
              </div>
            </>
          )}
        </>
      ) : null}
    </div>
  )
}
