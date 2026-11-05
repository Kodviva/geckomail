import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import type { FolderInfo } from '../../../shared/rpc'
import { decorateMenu, menuKeyNav } from '../menuNav'
import { fmtTime, t } from '../../../shared/i18n'
import { platform } from '../platform'
import { canManageAccount, moveTargets, rowMap, toMoveRow, touchPrimary } from '../moveDrag'
import { breakpointFor, navBreakpoint } from '../layout/useBreakpoint'

function extractDomain(addr: string | null | undefined): string {
  return addr?.split('@')[1] ?? ''
}

/** Erteleme seçenekleri: 1 saat sonra, bu akşam 18:00 (en az 15 dk varsa), yarın 09:00, pazartesi 09:00 */
function snoozeOptions(now = Date.now()): [string, number][] {
  const hm = (d: Date): string => fmtTime(d, { hour: '2-digit', minute: '2-digit' })
  const opts: [string, number][] = [[t('mail.snooze.inOneHour'), now + 3_600_000]]
  const tonight = new Date(now)
  tonight.setHours(18, 0, 0, 0)
  if (tonight.getTime() > now + 900_000) opts.push([t('mail.snooze.tonight', { time: hm(tonight) }), tonight.getTime()])
  const tom = new Date(now)
  tom.setDate(tom.getDate() + 1)
  tom.setHours(9, 0, 0, 0)
  opts.push([t('mail.snooze.tomorrow', { time: hm(tom) }), tom.getTime()])
  const mon = new Date(now)
  mon.setDate(mon.getDate() + ((1 - mon.getDay() + 7) % 7 || 7))
  mon.setHours(9, 0, 0, 0)
  opts.push([t('mail.snooze.monday', { time: hm(mon) }), mon.getTime()])
  return opts
}

export default function MessageContextMenu() {
  const ctx = useStore((s) => s.contextMenu)
  const closeContextMenu = useStore((s) => s.closeContextMenu)
  const messages = useStore((s) => s.messages)
  const checkedIds = useStore((s) => s.checkedIds)
  const select = useStore((s) => s.select)
  const openComposer = useStore((s) => s.openComposer)
  const markSeen = useStore((s) => s.markSeen)
  const setFlagged = useStore((s) => s.setFlagged)
  const moveRows = useStore((s) => s.moveRows)
  const currentUser = useStore((s) => s.currentUser)
  const accounts = useStore((s) => s.accounts)
  const openMoveDialog = useStore((s) => s.openMoveDialog)
  const startSelect = useStore((s) => s.startSelect)
  const moveSpecial = useStore((s) => s.moveSpecial)
  const snooze = useStore((s) => s.snooze)
  const smartView = useStore((s) => s.smartView)
  const deleteMessages = useStore((s) => s.deleteMessages)
  const openRuleBuilder = useStore((s) => s.openRuleBuilder)
  const quickSpamRule = useStore((s) => s.quickSpamRule)
  const selectBySender = useStore((s) => s.selectBySender)
  const selectByDomain = useStore((s) => s.selectByDomain)
  const setViewSource = useStore((s) => s.setViewSource)
  const toast = useStore((s) => s.toast)

  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  // erteleme seçenekleri alt menü açıldığı an hesaplanır ("bu akşam" saati geçtiyse görünmez)
  const [snoozeOpts, setSnoozeOpts] = useState<[string, number][] | null>(null)
  const [folders, setFolders] = useState<FolderInfo[] | null>(null)

  // iki aşamalı ölç-sonra-yerleştir: önce gizli render edilip ölçülür, sonra viewport'a kırpılmış konuma taşınır
  // yeni bağlam menüsü: alt menüler kapalı, klasör listesi yeniden istenir (render sırasında, kare kaybı yok)
  const [prevCtx, setPrevCtx] = useState(ctx)
  if (ctx !== prevCtx) {
    setPrevCtx(ctx)
    setMoveOpen(false)
    setSnoozeOpts(null)
    setFolders(null)
  }
  useLayoutEffect(() => {
    if (!ctx) return
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    setPos({ x: Math.min(ctx.x, Math.max(8, vw - rect.width - 8)), y: Math.min(ctx.y, Math.max(8, vh - rect.height - 8)) })
    // Escape'i güvenilir yakalamak için: bazı Electron/OS kombinasyonlarında window seviyeli
    // keydown listener'ına Escape hiç ulaşmıyor (ölçülü doğrulandı) — React'in kendi sentetik
    // event sistemi odaklı bir elemanda daha güvenilir, o yüzden menüye programatik focus veriyoruz.
    el.focus()
    decorateMenu(el)
  }, [ctx])

  // açılışı tetikleyen tıklamayla çakışmasın diye effect içinde (mount sonrası) kaydedilir
  useEffect(() => {
    if (!ctx) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeContextMenu()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [ctx, closeContextMenu])

  if (!ctx) return null
  const msg = messages.find((m) => m.id === ctx.messageId)
  if (!msg) return null

  // sağ-tıklanan mesaj checkedIds içindeyse tüm seçim hedeflenir; MessageView'da her zaman sadece o mesaj
  const targetIds =
    ctx.source === 'view' ? [ctx.messageId] : checkedIds.includes(ctx.messageId) ? checkedIds : [ctx.messageId]
  const targetMsgs = messages.filter((m) => targetIds.includes(m.id))
  const multi = targetIds.length > 1
  const allSeen = targetMsgs.every((m) => m.seen)
  const allUnseen = targetMsgs.every((m) => !m.seen)
  const allFlagged = targetMsgs.every((m) => m.flagged)
  const allUnflagged = targetMsgs.every((m) => !m.flagged)
  const sameAcct = new Set(targetMsgs.map((m) => m.accountId)).size === 1
  const manageable = canManageAccount(currentUser, accounts.find((a) => a.id === msg.accountId))
  const canMove = sameAcct && manageable
  const moveBlock = !sameAcct ? t('mail.move.mixedAccounts') : !manageable ? t('sync.perm.cannotManage') : undefined
  // okuma bölmesinden tek ileti (arşiv, sil gibi); listeden konu satırı bütün konuyu taşır
  const targetRows = targetMsgs.map((m) => (ctx.source === 'view' ? { id: m.id, accountId: m.accountId, folderId: m.folderId } : toMoveRow(m)))
  // "Seç" dokunmatik ve dar yerleşim içindir; geniş ekranda ⌘/Shift + tık var
  const canSelect = ctx.source === 'list' && (touchPrimary() || navBreakpoint(breakpointFor(window.innerWidth), platform.kind, true) !== 'wide')
  const domain = extractDomain(msg.fromAddr)

  const close = (): void => closeContextMenu()
  const run = (fn: () => void | Promise<void>): void => {
    void fn()
    close()
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      className="ctx-menu"
      style={{ left: pos?.x ?? ctx.x, top: pos?.y ?? ctx.y, visibility: pos ? 'visible' : 'hidden' }}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (menuKeyNav(e, ref.current)) return
        if (e.key === 'Escape') {
          e.stopPropagation()
          close()
        }
      }}
    >
      {ctx.source === 'list' && (
        <div className="ctx-item" onClick={() => run(() => select(ctx.messageId))}>
          <svg className="icon sm"><use href="#i-inbox" /></svg> {t('mail.ctx.open')}
        </div>
      )}
      {canSelect && (
        <div className="ctx-item" onClick={() => run(() => startSelect(ctx.messageId))}>
          <svg className="icon sm"><use href="#i-check" /></svg> {t('mail.ctx.select')}
        </div>
      )}
      <div
        className="ctx-item"
        onClick={() =>
          run(async () => {
            await select(ctx.messageId)
            openComposer('reply')
          })
        }
      >
        <svg className="icon sm"><use href="#i-reply" /></svg> {t('mail.action.reply')}
      </div>
      <div
        className="ctx-item"
        onClick={() =>
          run(async () => {
            await select(ctx.messageId)
            openComposer('replyAll')
          })
        }
      >
        <svg className="icon sm"><use href="#i-reply-all" /></svg> {t('mail.ctx.replyAll')}
      </div>
      <div
        className="ctx-item"
        onClick={() =>
          run(async () => {
            await select(ctx.messageId)
            openComposer('forward')
          })
        }
      >
        <svg className="icon sm"><use href="#i-forward" /></svg> {t('mail.action.forward')}
      </div>
      <div className="ctx-divider" />
      {!multi && (
        <div className="ctx-item" onClick={() => run(() => markSeen(targetIds, !msg.seen))}>
          <svg className="icon sm"><use href={msg.seen ? '#i-mail-dot' : '#i-mail-open'} /></svg> {msg.seen ? t('mail.action.markUnread') : t('mail.action.markRead')}
        </div>
      )}
      {multi && (
        <>
          <div className={`ctx-item ${allSeen ? 'dim' : ''}`} onClick={() => !allSeen && run(() => markSeen(targetIds, true))}>
            <svg className="icon sm"><use href="#i-mail-open" /></svg> {t('mail.action.markRead')}
          </div>
          <div className={`ctx-item ${allUnseen ? 'dim' : ''}`} onClick={() => !allUnseen && run(() => markSeen(targetIds, false))}>
            <svg className="icon sm"><use href="#i-mail-dot" /></svg> {t('mail.action.markUnread')}
          </div>
        </>
      )}
      {!multi && (
        <div className="ctx-item" onClick={() => run(() => setFlagged(targetIds, !msg.flagged))}>
          {msg.flagged ? (
            <>
              <svg className="icon sm"><use href="#i-star" /></svg> {t('mail.action.unstar')}
            </>
          ) : (
            <>
              <svg className="icon sm filled star-ic"><use href="#i-star" /></svg> {t('mail.action.star')}
            </>
          )}
        </div>
      )}
      {multi && (
        <>
          <div className={`ctx-item ${allFlagged ? 'dim' : ''}`} onClick={() => !allFlagged && run(() => setFlagged(targetIds, true))}>
            <svg className="icon sm filled star-ic"><use href="#i-star" /></svg> {t('mail.action.star')}
          </div>
          <div
            className={`ctx-item ${allUnflagged ? 'dim' : ''}`}
            onClick={() => !allUnflagged && run(() => setFlagged(targetIds, false))}
          >
            <svg className="icon sm"><use href="#i-star" /></svg> {t('mail.action.unstar')}
          </div>
        </>
      )}
      <div
        className="ctx-item ctx-sub"
        title={moveBlock}
        // tıklama ve Enter pencereyi açar: dokunmatikte üzerine gelme yok, klavyede alt menü yok
        onClick={() => canMove && run(() => openMoveDialog(targetRows))}
        onMouseEnter={() => {
          if (!canMove) return
          setMoveOpen(true)
          if (!folders) void rpc.call('getFoldersOf', { accountId: msg.accountId }).then(setFolders).catch(() => setFolders([]))
        }}
        onMouseLeave={() => setMoveOpen(false)}
      >
        <span className={canMove ? '' : 'dim'}>
          <svg className="icon sm"><use href="#i-folder" /></svg> {t('mail.ctx.move')} <svg className="icon sm"><use href="#i-chevron" /></svg>
        </span>
        {moveOpen && canMove && (
          <div className="ctx-submenu">
            {!folders && <div className="ctx-item dim">{t('state.loading')}</div>}
            {folders && moveTargets(folders, targetIds, rowMap(targetRows), msg.accountId).map((f) => (
              <div
                key={f.id}
                className="ctx-item"
                onClick={(e) => {
                  e.stopPropagation()
                  run(() => moveRows(targetRows, f.id))
                }}
              >
                {f.display}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="ctx-item" onClick={() => run(() => moveSpecial(targetIds, 'archive'))}>
        <svg className="icon sm"><use href="#i-archive" /></svg> {t('mail.action.archive')}
      </div>
      <div className="ctx-item" onClick={() => run(() => moveSpecial(targetIds, 'junk'))}>
        <svg className="icon sm"><use href="#i-alert" /></svg> {t('mail.ctx.moveToSpam')}
      </div>
      {smartView === 'snoozed' && (
        <div className="ctx-item" onClick={() => run(() => snooze(targetIds, 0))}>
          <svg className="icon sm"><use href="#i-inbox" /></svg> {t('mail.ctx.unsnooze')}
        </div>
      )}
      <div
        className="ctx-item ctx-sub"
        onMouseEnter={() => setSnoozeOpts(snoozeOptions())}
        onMouseLeave={() => setSnoozeOpts(null)}
      >
        <span>
          <svg className="icon sm"><use href="#i-clock" /></svg> {t('mail.ctx.snooze')} <svg className="icon sm"><use href="#i-chevron" /></svg>
        </span>
        {snoozeOpts && (
          <div className="ctx-submenu">
            {snoozeOpts.map(([label, at]) => (
              <div key={label} className="ctx-item" onClick={() => run(() => snooze(targetIds, at))}>
                {label}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="ctx-divider" />
      <div className="ctx-item" onClick={() => run(() => selectBySender(msg.fromAddr))}>
        {t('mail.ctx.selectBySender')}
      </div>
      <div className="ctx-item" onClick={() => run(() => selectByDomain(msg.fromAddr))}>
        {t('mail.ctx.selectByDomain')}
      </div>
      <div
        className="ctx-item"
        onClick={() =>
          run(() =>
            openRuleBuilder({ senderAddr: msg.fromAddr ?? undefined, domain: domain || undefined, subject: msg.subject ?? undefined })
          )
        }
      >
        <svg className="icon sm"><use href="#i-zap" /></svg> {t('mail.ctx.createRule')}
      </div>
      <div
        className="ctx-item"
        onClick={() => {
          if (!msg.fromAddr) return
          if (window.confirm(t('mail.ctx.alwaysSpamConfirm', { addr: msg.fromAddr }))) {
            run(() => quickSpamRule(msg.fromAddr))
          }
        }}
      >
        <svg className="icon sm"><use href="#i-ban" /></svg> {t('mail.ctx.alwaysSpam')}
      </div>
      <div className="ctx-divider" />
      <div className="ctx-item" onClick={() => run(() => setViewSource(msg.id))}>
        {t('mail.source.title')}
      </div>
      <div
        className="ctx-item"
        onClick={() =>
          run(() => {
            void rpc
              .call('getRawSource', { messageId: msg.id })
              .then(({ filename, data }) => platform.saveBytes(filename, data))
              .catch((e) => toast(String((e as Error).message), 'error'))
          })
        }
      >
        {t('mail.ctx.saveEml')}
      </div>
      <div className="ctx-divider" />
      <div className="ctx-item danger" onClick={() => run(() => deleteMessages(targetIds))}>
        <svg className="icon sm"><use href="#i-trash" /></svg> {t('action.delete')}
      </div>
    </div>
  )
}
