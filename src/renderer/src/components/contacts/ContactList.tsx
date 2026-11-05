// Sanal liste: kitaplıkta on binlerce kart olabilir. Toplanan adres satırı karta dönüştürme düğmesi taşır.
import { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { ContactSummary, PimCollectionInfo } from '../../../../shared/pim'
import type { Contact } from '../../../../shared/rpc'
import { t } from '../../../../shared/i18n'
import { rpc } from '../../rpcClient'
import { useStore } from '../../store'
import { COLLECTED, type BookChoice } from './ContactsPage'

const ROW_HEIGHT = 58

const initials = (name: string): string => name.trim().split(/\s+/).slice(0, 2).map((w) => [...w][0] ?? '').join('').toLocaleUpperCase()

export default function ContactList({ book, rows, collected, hasMore, selectedId, target, onSelect, onMore }: {
  book: BookChoice
  rows: ContactSummary[]
  collected: Contact[]
  hasMore: boolean
  selectedId: number | null
  target: PimCollectionInfo | null
  onSelect: (id: number) => void
  onMore: () => void
}) {
  const toast = useStore((s) => s.toast)
  const refreshContacts = useStore((s) => s.refreshContacts)
  const [busy, setBusy] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const isCollected = book === COLLECTED
  const offline = useStore((s) => s.offlineMode)
  const count = isCollected ? collected.length : rows.length + (hasMore ? 1 : 0)
  const virtualizer = useVirtualizer({ count, getScrollElement: () => scroller.current, estimateSize: () => ROW_HEIGHT, overscan: 10 })
  const items = virtualizer.getVirtualItems()
  const last = items[items.length - 1]?.index ?? -1
  useEffect(() => {
    if (!isCollected && hasMore && last >= rows.length) onMore()
    // sayfa isteği yalnız son satır görününce
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last, hasMore, rows.length, isCollected])

  const promote = async (c: Contact): Promise<void> => {
    if (!target) return
    setBusy(c.addr)
    try {
      const { id } = await rpc.call('promoteCollected', { addr: c.addr, name: c.name, collectionId: target.id })
      await refreshContacts()
      toast(t('contacts.promoted', { book: target.name }), 'info')
      onSelect(id)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  if (!count) return <div className="pim-empty">{t(offline ? 'contacts.offlineEmpty' : isCollected ? 'contacts.collectedEmpty' : 'contacts.empty')}</div>
  return (
    <div className="list-body" ref={scroller} role="list">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {items.map((v) => {
          const style = { position: 'absolute', top: 0, insetInlineStart: 0, width: '100%', height: v.size, transform: `translateY(${v.start}px)` } as const
          if (isCollected) {
            const c = collected[v.index]
            return (
              <div key={c.addr} role="listitem" className="contact-row" style={style}>
                <div className="contact-main">
                  <div className="contact-name">{c.name ?? c.addr}</div>
                  <div className="contact-sub">{c.addr}</div>
                </div>
                {target && <button type="button" className="sm" disabled={busy === c.addr} onClick={() => void promote(c)}>{t('contacts.promote')}</button>}
              </div>
            )
          }
          const r = rows[v.index]
          if (!r) return <div key="more" style={style} className="contact-row contact-more">{t('contacts.loading')}</div>
          return (
            <button key={r.id} type="button" role="listitem" className={`contact-row${r.id === selectedId ? ' active' : ''}`} style={style} onClick={() => onSelect(r.id)}>
              <span className="contact-avatar" aria-hidden="true">{r.kind === 'group' ? <svg className="icon sm"><use href="#i-users" /></svg> : initials(r.fullName)}</span>
              <span className="contact-main">
                <span className="contact-name">{r.fullName}</span>
                <span className="contact-sub">{r.kind === 'group' ? t('contacts.groupLabel') : r.emails[0]?.addr ?? r.org ?? ''}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
