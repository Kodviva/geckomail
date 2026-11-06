import { useEffect, useMemo, useState } from 'react'
import DOMPurify from 'dompurify'
import { useStore } from '../store'
import { rpc } from '../rpcClient'
import { usePopover } from './usePopover'
import { SEALED_ATTACHMENT_SUFFIX } from '../../../shared/attachmentFiles'
import type { AttachmentInfo, MessageRow } from '../../../shared/rpc'
import { fmtDate, fmtDateTime, fmtNumber, getUiOs, t } from '../../../shared/i18n'
import { platform } from '../platform'
import { BackButton, useNavDrawer } from '../layout/MobileNav'
import { useLongPress } from '../layout/useLongPress'
import { canManageAccount } from '../moveDrag'
import { isCalendarAttachment } from '../../../shared/pim'
import InviteCard from './InviteCard'
import SmimeBadges from './SmimeBadges'
import { isDangerousAttachment } from '../../../shared/attachmentSafety'
import { smimeBadges } from '../../../shared/smime'

// her linkte gerçek hedefi native tooltip olarak göster (oltalama farkındalığı)
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    const href = node.getAttribute('href')
    if (href) node.setAttribute('title', t('mail.view.realAddress', { href }))
  }
})

function fmtSize(n: number | null): string {
  if (!n) return ''
  if (n < 1024) return t('mail.size.b', { n: fmtNumber(n) })
  if (n < 1048576) return t('mail.size.kb', { n: fmtNumber(n / 1024, { maximumFractionDigits: 0 }) })
  return t('mail.size.mb', { n: fmtNumber(n / 1048576, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
}

// Mail HTML'i asla ana DOM'a girmez: DOMPurify → sandboxed iframe + CSP.
// Uzak resimler hiçbir zaman iframe'den yüklenmez — istenirse sync süreci
// çerezsiz indirip data: URI'ye çevirir; CSP img-src data: sabit kalır.
function buildSrcdoc(rawHtml: string, remoteMap: Record<string, string> | null, cidMap: Map<string, string>): string {
  let html = rawHtml.replace(/(src\s*=\s*["'])cid:([^"']+)(["'])/gi, (_all, pre: string, id: string, post: string) => {
    const data = cidMap.get(id.trim())
    return data ? `${pre}${data}${post}` : `${pre}${post}`
  })
  if (remoteMap) {
    html = html.replace(/(src\s*=\s*["'])(https?:[^"']+)(["'])/gi, (_all, pre: string, url: string, post: string) => {
      const data = remoteMap[url]
      return data ? `${pre}${data}${post}` : `${pre}${post}`
    })
  }
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'base', 'link', 'audio', 'video'],
    FORBID_ATTR: ['srcset', 'ping', 'formaction'],
    ALLOW_UNKNOWN_PROTOCOLS: false
  })
  const csp = `default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;`
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><base target="_blank"><style>
    body { font: 14px -apple-system, 'Segoe UI', sans-serif; margin: 14px; color: #1a1a1a; background: #fff; word-break: break-word; }
    img { max-width: 100%; height: auto; }
    pre { white-space: pre-wrap; }
    blockquote { border-left: 3px solid #ccc; margin-left: 4px; padding-left: 10px; color: #555; }
  </style></head><body>${clean}</body></html>`
}

// Konuşma şeridi: aynı zincirdeki diğer mesajlar (tıkla → o mesajı aç)
function ThreadStrip({ threadRoot, currentId }: { threadRoot: string; currentId: number }) {
  const folderKind = useStore((s) => s.folderKind)
  const select = useStore((s) => s.select)
  // sonuç sorgusunun anahtarıyla saklanır: zincir değişince eski liste görünmez
  const key = `${threadRoot}\u0000${folderKind}`
  const [res, setRes] = useState<{ key: string; items: MessageRow[] } | null>(null)
  useEffect(() => {
    void rpc
      .call('getThread', { threadRoot, folderKind })
      .then((items) => setRes({ key, items }))
      .catch(() => setRes({ key, items: [] }))
  }, [threadRoot, folderKind, key])
  const items = res?.key === key ? res.items : null
  if (!items || items.length < 2) return null
  return (
    <div className="thread-strip">
      <span className="thread-label">
        <svg className="icon sm"><use href="#i-thread" /></svg> {t('mail.view.threadCount', { count: items.length })}
      </span>
      {items.map((m) => (
        <span
          key={m.id}
          className={`thread-item ${m.id === currentId ? 'active' : ''} ${m.seen ? '' : 'unread'}`}
          onClick={() => m.id !== currentId && void select(m.id)}
          title={`${m.fromName || m.fromAddr || ''} — ${fmtDateTime(m.date)}`}
        >
          {(m.fromName || m.fromAddr || '?').split(' ')[0]} · {fmtDate(m.date, { day: 'numeric', month: 'short' })}
        </span>
      ))}
    </div>
  )
}

// çevrimdışı: yazma düğmeleri kapalı, nedeni düğmenin üzerinde
type WriteLock = { disabled?: boolean; title?: string }

// ⋯ taşma menüsü: seyrek kullanılanlar (yazı boyutu, yazdır)
function MoreMenu({ scale, onScale }: { scale: number; onScale: (delta: number | null) => void }) {
  const { open, setOpen, ref, toggle } = usePopover<HTMLSpanElement>()
  return (
    <span className="menu-anchor" ref={ref}>
      <button
        type="button"
        className="btn btn-ghost btn-icon btn-sm"
        onClick={toggle}
        data-tip={t('mail.view.more')}
        data-tip-align="end"
        aria-label={t('mail.view.moreActions')}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <svg className="icon sm"><use href="#i-more" /></svg>
      </button>
      {open && (
        <div className="menu overflow-menu" role="menu">
          <div className="menu-label">{t('mail.view.textSize')}</div>
          <div className="menu-stepper">
            <button type="button" className="btn btn-sm btn-icon" onClick={() => onScale(-0.1)} disabled={scale <= 0.8} aria-label={t('mail.view.textSmaller')}>
              A−
            </button>
            <output aria-live="polite">{fmtNumber(Math.round(scale * 100) / 100, { style: 'percent' })}</output>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => onScale(0.1)} disabled={scale >= 1.6} aria-label={t('mail.view.textLarger')}>
              A+
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => onScale(null)} disabled={scale === 1}>
              {t('mail.view.reset')}
            </button>
          </div>
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false)
              window.print()
            }}
          >
            <svg className="icon sm"><use href="#i-printer" /></svg> {t('mail.view.print')}
          </button>
        </div>
      )}
    </span>
  )
}

function UnsubscribeBar({ messageId }: { messageId: number }) {
  const toast = useStore((s) => s.toast)
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')
  if (state === 'done')
    return (
      <div className="remote-bar">
        <span>{t('mail.unsub.sent')}</span>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => useStore.getState().setSubscriptionsOpen(true)}>
          {t('mail.unsub.all')}
        </button>
      </div>
    )
  return (
    <div className="remote-bar">
      <span>{t('mail.unsub.supported')}</span>
      <button
        type="button"
        className="btn btn-sm"
        disabled={state === 'busy'}
        onClick={() => {
          setState('busy')
          void rpc
            .call('unsubscribe', { messageId })
            .then((r) => {
              if (r.ok) setState('done')
              else {
                setState('idle')
                toast(t('mail.unsub.failed', { error: r.error }), 'error')
              }
            })
            .catch((e) => {
              setState('idle')
              toast(String((e as Error).message), 'error')
            })
        }}
      >
        {state === 'busy' ? t('mail.unsub.sending') : t('mail.unsub.action')}
      </button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => useStore.getState().setSubscriptionsOpen(true)} title={t('mail.unsub.allTitle')}>
        {t('mail.unsub.all')}
      </button>
    </div>
  )
}

function AttachmentChip({ a, messageId }: { a: AttachmentInfo; messageId: number }) {
  const toast = useStore((s) => s.toast)
  const offlineMode = useStore((s) => s.offlineMode)
  const [busy, setBusy] = useState(false)
  // çözülmüş ek RAM'dedir: açmak düz metin geçici dosya yazardı, yalnız kaydedilir
  const saveDecrypted = async (index: number) => {
    const name = a.filename ?? t('mail.att.defaultName')
    if (isDangerousAttachment(name) && !window.confirm(t('smime.att.dangerConfirm', { name }))) return
    setBusy(true)
    try {
      await platform.saveSmimeAttachment({ messageId, index, name })
    } catch (e) {
      toast(t('mail.att.downloadFailed', { error: String((e as Error).message) }))
    } finally {
      setBusy(false)
    }
  }
  const open = async (reveal: boolean) => {
    if (offlineMode) return toast(t('common.offlineNoAttachment'), 'info')
    setBusy(true)
    try {
      const ref = { messageId, attachmentId: a.id, name: a.filename ?? '' }
      if (reveal) await platform.revealAttachment(ref)
      else await platform.openAttachment(ref)
    } catch (e) {
      toast(t('mail.att.downloadFailed', { error: String((e as Error).message) }))
    } finally {
      setBusy(false)
    }
  }
  if (a.smimeIndex != null) {
    const index = a.smimeIndex
    return (
      <span className={`att-chip ${busy ? 'busy' : ''}`}>
        <span className="att-name" onClick={() => void saveDecrypted(index)} title={t('smime.att.save')}>
          <svg className="icon xs"><use href="#i-save" /></svg> {a.filename ?? t('mail.att.defaultName')} {a.size ? `(${fmtSize(a.size)})` : ''}
        </span>
      </span>
    )
  }
  return (
    <span className={`att-chip ${busy ? 'busy' : ''}`}>
      <span className="att-name" onClick={() => void open(false)} title={t('mail.att.open')}>
        <svg className="icon xs"><use href="#i-clip" /></svg> {a.filename ?? t('mail.att.defaultName')} {a.size ? `(${fmtSize(a.size)})` : ''}
      </span>
      <span className="att-reveal" onClick={() => void open(true)} title={t(getUiOs() === 'windows' ? 'mail.att.revealExplorer' : 'mail.att.reveal')}>
        <svg className="icon xs"><use href="#i-folder" /></svg>
      </span>
    </span>
  )
}

export default function MessageView() {
  const selectedMessageId = useStore((s) => s.selectedMessageId)
  const messages = useStore((s) => s.messages)
  const body = useStore((s) => s.body)
  const accounts = useStore((s) => s.accounts)
  const allowRemoteImages = useStore((s) => s.allowRemoteImages)
  const setAllowRemoteImages = useStore((s) => s.setAllowRemoteImages)
  const openComposer = useStore((s) => s.openComposer)
  const deleteMessages = useStore((s) => s.deleteMessages)
  const markSeen = useStore((s) => s.markSeen)
  const setFlagged = useStore((s) => s.setFlagged)
  const refreshBody = useStore((s) => s.refreshBody)
  const openMoveDialog = useStore((s) => s.openMoveDialog)
  const moveSpecial = useStore((s) => s.moveSpecial)
  const openContextMenu = useStore((s) => s.openContextMenu)
  const offlineMode = useStore((s) => s.offlineMode)
  const lock: WriteLock = offlineMode ? { disabled: true, title: t('common.offlineReadOnly') } : {}
  const currentUser = useStore((s) => s.currentUser)
  const [cidMap, setCidMap] = useState<Map<string, string>>(new Map())
  const [remoteMap, setRemoteMap] = useState<Record<string, string> | null>(null)
  const [loadingRemote, setLoadingRemote] = useState(false)

  // Okuyucu yazı boyutu (A− / A+): yalnızca gövdeye uygulanır, başlığa değil.
  // localStorage 'gecko-reader-scale' ile kalıcı; 0.8–1.6 arası, 0.1 adım.
  const [readerScale, setReaderScale] = useState<number>(() => {
    const raw = Number(localStorage.getItem('gecko-reader-scale'))
    return raw >= 0.8 && raw <= 1.6 ? raw : 1
  })
  useEffect(() => {
    localStorage.setItem('gecko-reader-scale', String(readerScale))
  }, [readerScale])
  const bumpScale = (delta: number) =>
    setReaderScale((s) => Math.min(1.6, Math.max(0.8, Math.round((s + delta) * 10) / 10)))

  const msg = messages.find((m) => m.id === selectedMessageId)
  const account = accounts.find((a) => a.id === msg?.accountId)
  // şifreli görünümde ağ yok (EFAIL): uzak resim çubuğu, onayı ve adresleri devre dışı
  const smimeInfo = body?.state === 'ready' ? body.smime : undefined
  const encryptedView = msg?.smimeKind === 'encrypted' || (!!smimeInfo && smimeInfo.enc !== 'none')

  // "Resimleri yükle": proxy üzerinden indir, iframe ağa çıkmaz
  useEffect(() => {
    setRemoteMap(null)
    setLoadingRemote(false)
  }, [selectedMessageId])

  useEffect(() => {
    if (!allowRemoteImages || !msg || remoteMap || loadingRemote || encryptedView) return
    setLoadingRemote(true)
    void rpc
      .call('fetchRemoteImages', { messageId: msg.id })
      .then(({ images }) => setRemoteMap(images))
      .catch(() => setRemoteMap({}))
      .finally(() => setLoadingRemote(false))
  }, [allowRemoteImages, msg, remoteMap, loadingRemote, encryptedView])

  // cid: satır içi resimleri ek önbelleğinden data: URL'lere çevir
  useEffect(() => {
    setCidMap(new Map())
    if (!msg || body?.state !== 'ready' || !body.html) return
    const wanted = body.attachments.filter((a) => a.contentId && body.html!.includes(`cid:${a.contentId}`))
    if (!wanted.length) return
    let cancelled = false
    void (async () => {
      const map = new Map<string, string>()
      for (const a of wanted.slice(0, 20)) {
        try {
          if (a.smimeIndex != null) {
            // yalnız resim: metadata gönderenin elindedir, data: adresine kaçışsız girmez
            if (!/^image\/[\w.+-]+$/.test(a.mime ?? '')) continue
            const { base64, mime } = await rpc.call('getSmimeAttachment', { messageId: msg.id, index: a.smimeIndex })
            if (/^image\/[\w.+-]+$/.test(mime)) map.set(a.contentId!, `data:${mime};base64,${base64}`)
            continue
          }
          // mühürlü önbellek doğrudan okunur: düz kopya yalnız kullanıcı eki açınca oluşur
          if (!a.diskPath?.endsWith(SEALED_ATTACHMENT_SUFFIX)) await rpc.call('getAttachment', { messageId: msg.id, attachmentId: a.id })
          const { base64, mime } = await rpc.call('getAttachmentData', { messageId: msg.id, attachmentId: a.id })
          map.set(a.contentId!, `data:${mime ?? 'image/png'};base64,${base64}`)
        } catch {
          /* inline resim yüklenemedi — boş kalır */
        }
      }
      if (!cancelled) setCidMap(map)
    })()
    return () => {
      cancelled = true
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bilinçli: yalnız açılışta / belirtilen değişkenlerle
  }, [selectedMessageId, body?.state, smimeInfo?.enc])

  // dokunmatik: başlık alanında uzun basma sağ tıkla aynı menüyü açar; düğme/bağlantı ve seçilebilir konu
  // metninde yerel davranış kalır (kanca erken dönüşlerden önce)
  const longPress = useLongPress(
    (x, y) => {
      if (msg) openContextMenu(x, y, msg.id, 'view')
    },
    'button, a, input, select, .view-subject, .att-row'
  )
  const drawerOpen = useNavDrawer((s) => s.open) // çekmece açıkken arka plan etkileşimsiz

  const srcdoc = useMemo(() => {
    if (body?.state !== 'ready' || !body.html) return null
    // çevrimdışı: uzak resim adresleri hiç kalmaz (boş eşleme src'yi siler), tarayıcı denemez bile
    return buildSrcdoc(body.html, encryptedView ? {} : (remoteMap ?? (offlineMode ? {} : null)), cidMap)
  }, [body, remoteMap, cidMap, offlineMode, encryptedView])

  if (!msg) {
    return (
      <section className="viewpane empty" inert={drawerOpen}>
        <BackButton />
        <div className="empty-note">{t('mail.view.selectPrompt')}</div>
      </section>
    )
  }

  if (msg.locked) {
    return (
      <section className="viewpane empty" inert={drawerOpen}>
        <BackButton />
        <div className="empty-note vault-locked-note">
          <svg className="icon lg"><use href="#i-lock" /></svg>
          <div>{t('mail.view.vaultLocked')}</div>
          <button className="primary" onClick={() => useStore.getState().setVaultPromptOpen(true)}>{t('mail.view.unlockVault')}</button>
        </div>
      </section>
    )
  }

  const toList = (() => {
    try {
      return msg.toJson
        ? (JSON.parse(msg.toJson) as Array<{ name?: string; address?: string }>)
            .map((r) => r.name || r.address)
            .filter(Boolean)
            .join(', ')
        : ''
    } catch {
      return ''
    }
  })()

  const hasRemoteImgs = !encryptedView && body?.state === 'ready' && !!body.html && /src\s*=\s*["']https?:/i.test(body.html)

  // kilitli, anahtarsız ya da çözülemeyen şifreli ileti: "boş ileti" denmez, neden söylenir
  const noPlain = body?.state === 'ready' && !body.html && !body.textPlain && !!smimeInfo && smimeInfo.enc !== 'none' && smimeInfo.enc !== 'decrypted'

  return (
    <section
      className="viewpane"
      inert={drawerOpen}
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenu(e.clientX, e.clientY, msg.id, 'view')
      }}
    >
      <div className="view-toolbar toolbar" role="toolbar" aria-label={t('mail.view.toolbar')}>
        <BackButton />
        <div className="btn-group">
          <button type="button" className="btn btn-sm" onClick={() => openComposer('reply')} {...lock} data-tip={t('mail.action.replyTip')} data-tip-align="start" aria-label={t('mail.action.reply')}>
            <svg className="icon sm"><use href="#i-reply" /></svg>
            <span className="btn-label">{t('mail.action.reply')}</span>
          </button>
          <button type="button" className="btn btn-sm" onClick={() => openComposer('replyAll')} {...lock} data-tip={t('mail.action.replyAllTip')} aria-label={t('mail.action.replyAll')}>
            <svg className="icon sm"><use href="#i-reply-all" /></svg>
            <span className="btn-label">{t('mail.action.replyAllShort')}</span>
          </button>
          <button type="button" className="btn btn-sm" onClick={() => openComposer('forward')} {...lock} data-tip={t('mail.action.forwardTip')} aria-label={t('mail.action.forward')}>
            <svg className="icon sm"><use href="#i-forward" /></svg>
            <span className="btn-label">{t('mail.action.forward')}</span>
          </button>
        </div>
        <span className="spacer" />
        <div className="toolbar-group">
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => moveSpecial([msg.id], 'archive')} {...lock} data-tip={t('mail.action.archiveTip')} aria-label={t('mail.action.archive')}>
            <svg className="icon sm"><use href="#i-archive" /></svg>
          </button>
          <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => moveSpecial([msg.id], 'junk')} {...lock} data-tip={t('mail.action.moveToSpamFolder')} aria-label={t('mail.action.markSpam')}>
            <svg className="icon sm"><use href="#i-alert" /></svg>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-caret"
            onClick={() => openMoveDialog([{ id: msg.id, accountId: msg.accountId, folderId: msg.folderId }])}
            data-tip={t('mail.view.moveToFolder')}
            aria-label={t('mail.view.moveToFolder')}
            aria-haspopup="dialog"
            {...(offlineMode || canManageAccount(currentUser, accounts.find((a) => a.id === msg.accountId))
              ? lock
              : { disabled: true, title: t('sync.perm.cannotManage') })}
          >
            <svg className="icon sm"><use href="#i-folder" /></svg>
            <svg className="icon caret"><use href="#i-caret" /></svg>
          </button>
        </div>
        <span className="toolbar-sep" aria-hidden="true" />
        <div className="toolbar-group">
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => markSeen([msg.id], !msg.seen)}
            {...lock}
            data-tip={msg.seen ? t('mail.action.markUnreadTip') : t('mail.action.markReadTip')}
            aria-label={msg.seen ? t('mail.action.markUnread') : t('mail.action.markRead')}
          >
            <svg className="icon sm"><use href={msg.seen ? '#i-mail-dot' : '#i-mail-open'} /></svg>
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-icon btn-sm"
            onClick={() => setFlagged([msg.id], !msg.flagged)}
            {...lock}
            data-tip={msg.flagged ? t('mail.action.unstarTip') : t('mail.action.starTip')}
            aria-label={msg.flagged ? t('mail.action.unstar') : t('mail.action.star')}
            aria-pressed={msg.flagged}
          >
            <svg className={`icon sm ${msg.flagged ? 'filled star-ic' : ''}`}><use href="#i-star" /></svg>
          </button>
          <button type="button" className="btn btn-ghost btn-icon btn-sm danger" onClick={() => deleteMessages([msg.id])} {...lock} data-tip={t('mail.action.deleteTip')} aria-label={t('action.delete')}>
            <svg className="icon sm"><use href="#i-trash" /></svg>
          </button>
        </div>
        <span className="toolbar-sep" aria-hidden="true" />
        <MoreMenu scale={readerScale} onScale={(d) => (d == null ? setReaderScale(1) : bumpScale(d))} />
      </div>
      <div className="view-head" {...longPress}>
        <div className="view-subject">{msg.subject || t('mail.common.noSubject')}</div>
        <div className="view-meta">
          <span className="acct-chip" title={t('mail.view.accountTitle')}>
            <span className="acct-color" style={{ background: account?.color ?? '#888' }} />
            {account?.email ?? ''}
          </span>
          <span>
            <b>{msg.fromName || msg.fromAddr}</b>
            {msg.fromName && msg.fromAddr ? ` <${msg.fromAddr}>` : ''}
          </span>
        </div>
        <div className="view-meta sub">
          {toList && <span>{t('mail.view.to', { list: toList })}</span>}
          <span>{fmtDateTime(msg.date)}</span>
        </div>
        {smimeInfo && <SmimeBadges key={msg.id} info={smimeInfo} messageId={msg.id} />}
        {msg.threadRoot && <ThreadStrip threadRoot={msg.threadRoot} currentId={msg.id} />}
        {msg.canUnsubscribe && !offlineMode && <UnsubscribeBar key={msg.id} messageId={msg.id} />}
        {body?.state === 'ready' && !offlineMode && body.attachments.some(isCalendarAttachment) && <InviteCard key={msg.id} messageId={msg.id} />}
        {body?.state === 'ready' && body.attachments.filter((a) => !a.contentId || !body.html?.includes(`cid:${a.contentId}`)).length > 0 && (
          <div className="att-row">
            {body.attachments
              .filter((a) => !a.contentId || !body.html?.includes(`cid:${a.contentId}`))
              .map((a) => (
                <AttachmentChip key={a.id} a={a} messageId={msg.id} />
              ))}
          </div>
        )}
        {hasRemoteImgs && !remoteMap && (
          <div className="remote-bar">
            <span>{t('mail.view.remoteBlocked')}</span>
            <button type="button" className="btn btn-sm" disabled={loadingRemote || offlineMode} title={lock.title} onClick={() => setAllowRemoteImages(true)}>
              {loadingRemote ? t('mail.view.remoteLoading') : t('mail.view.remoteLoad')}
            </button>
          </div>
        )}
      </div>
      <div className="view-body" style={{ zoom: readerScale }}>
        {(!body || body.state === 'fetching') && <div className="empty-note">{t('mail.view.bodyLoading')}</div>}
        {body?.state === 'error' && (
          <div className="empty-note">
            {t('mail.view.bodyError', { error: body.error })}
            <button onClick={() => void refreshBody()}>{t('action.retry')}</button>
          </div>
        )}
        {body?.state === 'ready' && noPlain && smimeInfo && (
          <div className="empty-note">{t(smimeBadges(smimeInfo)[0]?.detailKey ?? 'mail.view.emptyBody')}</div>
        )}
        {body?.state === 'ready' && !noPlain &&
          (srcdoc ? (
            <iframe title={t('mail.view.frameTitle')} className="mail-frame" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={srcdoc} />
          ) : (
            <pre className="mail-plain">{body.textPlain ?? t('mail.view.emptyBody')}</pre>
          ))}
      </div>
    </section>
  )
}
