import { useEffect, useState, type KeyboardEvent } from 'react'
import type { TemplateRow } from '../../../shared/rpc'
import { fillTemplate, templateVarNames } from '../../../shared/templateVars'
import { fmtNumber, fmtTime, t } from '../../../shared/i18n'
import { rpc } from '../rpcClient'
import { useStore } from '../store'
import RichEditor from './RichEditor'
import AddressInput from './AddressInput'
import Modal from './Modal'
import SmimeComposeBar, { useSmimeCheck } from './SmimeComposeBar'

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${fmtNumber(n / 1024, { maximumFractionDigits: 0 })} KB`
  return `${fmtNumber(n / 1048576, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`
}

// Şablonlar (R28): DB'de, cihaz senkronunda; {{ad}} gibi değişkenler eklenirken doldurulur.
// Eski sürümün localStorage şablonları ilk açılışta bir kez DB'ye taşınır.
const LEGACY_KEY = 'gecko-templates'
async function migrateLegacyTemplates(existing: TemplateRow[]): Promise<boolean> {
  let legacy: { name: string; body: string }[] = []
  try {
    const v = JSON.parse(localStorage.getItem(LEGACY_KEY) || '[]')
    if (Array.isArray(v)) legacy = v.filter((x) => x && typeof x.name === 'string' && typeof x.body === 'string')
  } catch {
    return false
  }
  if (!legacy.length) return false
  const have = new Set(existing.map((x) => x.name))
  for (const x of legacy) if (!have.has(x.name)) await rpc.call('saveTemplate', { name: x.name, subject: null, body: x.body })
  try {
    localStorage.removeItem(LEGACY_KEY)
  } catch {
    /* bir sonraki açılışta yeniden denenir; ad çakışması atlanır */
  }
  return true
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export default function Composer() {
  const composer = useStore((s) => s.composer)
  const setComposer = useStore((s) => s.setComposer)
  const closeComposer = useStore((s) => s.closeComposer)
  const accounts = useStore((s) => s.accounts)
  const send = useStore((s) => s.send)
  const sending = useStore((s) => s.sending)
  const addAttachments = useStore((s) => s.addAttachments)
  const removeAttachment = useStore((s) => s.removeAttachment)
  const [laterOpen, setLaterOpen] = useState(false)
  const [customAt, setCustomAt] = useState('')
  const [tplOpen, setTplOpen] = useState(false)
  const [templates, setTemplates] = useState<TemplateRow[]>([])
  const [richKey, setRichKey] = useState(0)
  const toast = useStore((s) => s.toast)
  const reloadTemplates = async (): Promise<void> => {
    try {
      const list = await rpc.call('listTemplates', {})
      if (await migrateLegacyTemplates(list)) setTemplates(await rpc.call('listTemplates', {}))
      else setTemplates(list)
    } catch (e) {
      toast(t('compose.template.loadFailed', { error: (e as Error).message }))
    }
  }
  useEffect(() => {
    void reloadTemplates()
    // yalnız açılışta; şablon menüsü açılınca da tazelenir
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bilinçli: yalnız açılışta / belirtilen değişkenlerle
  }, [])
  const smimeCheck = useSmimeCheck(composer)
  if (!composer) return null
  const c = composer
  const sendLocked = sending || !!smimeCheck.block

  // sonra-gönder hazır seçenekleri (renderer'da yerel saat hesabı)
  const now = Date.now()
  // at: tıklama anında hesaplanır (menü açık kaldıkça "1 saat" eskimesin); key yeniden denemede aynı zamanı korur
  const laterOptions: { key: string; label: string; at: () => number }[] = [
    { key: 'inHour', label: t('compose.later.inHour'), at: () => Date.now() + 3_600_000 }
  ]
  const tonight = new Date()
  tonight.setHours(18, 0, 0, 0)
  if (tonight.getTime() > now + 900_000) laterOptions.push({ key: 'tonight', label: t('compose.later.tonight', { time: fmtTime(tonight) }), at: () => tonight.getTime() })
  const tom = new Date()
  tom.setDate(tom.getDate() + 1)
  tom.setHours(9, 0, 0, 0)
  laterOptions.push({ key: 'tomorrow', label: t('compose.later.tomorrow', { time: fmtTime(tom) }), at: () => tom.getTime() })
  const mon = new Date()
  mon.setDate(mon.getDate() + ((1 - mon.getDay() + 7) % 7 || 7))
  mon.setHours(9, 0, 0, 0)
  laterOptions.push({ key: 'monday', label: t('compose.later.monday', { time: fmtTime(mon) }), at: () => mon.getTime() })

  const scheduleCustom = (): void => {
    const at = new Date(customAt).getTime()
    if (Number.isFinite(at) && at > now + 30_000) {
      setLaterOpen(false)
      void send(at)
    }
  }

  // şablon ekle: değişkenleri doldur, düz metne ekle; zengin modda HTML'e ekleyip editörü remount et (key).
  // Şablonun konusu varsa ve mailin konusu boşsa konu da doldurulur.
  const insertTemplate = (tpl: TemplateRow): void => {
    setTplOpen(false)
    const acct = accounts.find((a) => a.id === c.fromAccountId)
    const ctx = { to: c.to, subject: c.subject, fromEmail: acct?.email ?? '', fromName: acct?.displayName ?? null }
    const body = fillTemplate(tpl.body, ctx)
    const subject = !c.subject.trim() && tpl.subject ? fillTemplate(tpl.subject, ctx) : c.subject
    if (c.rich) {
      const add = escapeHtml(body)
        .split('\n')
        .map((l) => `<p>${l || '<br>'}</p>`)
        .join('')
      setComposer({ ...c, subject, html: c.html + add })
      setRichKey((k) => k + 1)
    } else {
      setComposer({ ...c, subject, text: c.text ? `${c.text}\n\n${body}` : body })
    }
  }
  const saveAsTemplate = async (): Promise<void> => {
    let body = c.text
    if (c.rich) {
      const el = document.createElement('div')
      el.innerHTML = c.html
      body = el.innerText
    }
    if (!body.trim()) return toast(t('compose.template.nothingToSave'))
    const name = window.prompt(t('compose.template.namePrompt'))?.trim()
    if (!name) return
    // yeni mailde konu da şablona girer; yanıt/iletmede konu mail'e özgüdür
    const subject = (c.mode ?? 'new') === 'new' && c.subject.trim() ? c.subject.trim() : null
    try {
      await rpc.call('saveTemplate', { name, subject, body })
      await reloadTemplates()
      toast(t('compose.template.saved', { name }), 'info')
    } catch (e) {
      toast((e as Error).message)
    }
    setTplOpen(false)
  }
  const deleteTemplate = async (name: string): Promise<void> => {
    if (!window.confirm(t('compose.template.confirmDelete', { name }))) return
    try {
      await rpc.call('deleteTemplate', { name })
      await reloadTemplates()
    } catch (e) {
      toast((e as Error).message)
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      if (!sendLocked) void send()
    }
  }

  return (
    <Modal onClose={() => closeComposer()} className="composer" onKeyDown={onKeyDown}>
        <div className="modal-title">
          {/* dar ekran (tam ekran oluşturucu): kaplama yok, kapatma buradan ya da geri tuşuyla; taslak korunur */}
          <button type="button" className="btn btn-ghost btn-icon btn-sm nav-back-btn" aria-label={t('mail.nav.back')} title={t('mail.nav.back')} onClick={() => closeComposer()}>
            <svg className="icon nav-back-ic"><use href="#i-chevron" /></svg>
          </button>
          {c.mode === 'reply' || c.mode === 'replyAll'
            ? t(c.mode === 'replyAll' ? 'compose.title.replyAll' : 'compose.title.reply', {
                subject: c.subject.replace(/^re:\s*/i, '') || t('compose.common.noSubject')
              })
            : c.mode === 'forward'
              ? t('compose.title.forward', { subject: c.subject.replace(/^(ilt|fwd?):\s*/i, '') || t('compose.common.noSubject') })
              : t('compose.title.new')}
          {c.restored && <span className="restored-badge">{t('compose.title.restored')}</span>}
        </div>
        <label>
          {t('compose.field.from')}
          <select disabled={sending} value={c.fromAccountId} onChange={(e) => setComposer({ ...c, fromAccountId: Number(e.target.value) })}>
            {accounts
              .filter((a) => a.enabled)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.email}
                </option>
              ))}
          </select>
        </label>
        <label>
          {t('compose.field.to')}
          <AddressInput value={c.to} onChange={(to) => setComposer({ ...c, to })} placeholder={t('compose.field.toPlaceholder')} autoFocus disabled={sending} />
        </label>
        <div className="cc-row">
          <label>
            {t('compose.field.cc')}
            <AddressInput value={c.cc} onChange={(cc) => setComposer({ ...c, cc })} disabled={sending} />
          </label>
          <label>
            {t('compose.field.bcc')}
            <AddressInput value={c.bcc} onChange={(bcc) => setComposer({ ...c, bcc })} disabled={sending} />
          </label>
        </div>
        <label>
          {t('compose.field.subject')}
          <div className="subject-row">
            <input disabled={sending} value={c.subject} onChange={(e) => setComposer({ ...c, subject: e.target.value })} />
            <button
              type="button"
              disabled={sending}
              className={`btn btn-icon ${c.rich ? 'active' : ''}`}
              aria-pressed={c.rich}
              title={c.rich ? t('compose.format.toPlain') : t('compose.format.toRich')}
              onClick={() => {
                if (c.rich) {
                  const el = document.createElement('div')
                  el.innerHTML = c.html
                  setComposer({ ...c, rich: false, text: el.innerText })
                } else {
                  setComposer({ ...c, rich: true })
                }
              }}
            >
              Aa
            </button>
          </div>
        </label>
        {c.rich ? (
          <RichEditor key={`rich-${richKey}`} initialHtml={c.html} initialText={c.text} onChange={(html) => setComposer({ ...useStore.getState().composer!, html })} disabled={sending} />
        ) : (
          <textarea disabled={sending} value={c.text} onChange={(e) => setComposer({ ...c, text: e.target.value })} rows={12} />
        )}
        {c.attachments.length > 0 && (
          <div className="att-row">
            {c.attachments.map((a, i) => (
              <span key={i} className="att-chip">
                <svg className="icon sm"><use href="#i-clip" /></svg> {a.filename} ({fmtSize(a.size)})
                <span className="att-remove" onClick={() => !sending && removeAttachment(i)} title={t('action.remove')}>
                  <svg className="icon sm"><use href="#i-x" /></svg>
                </span>
              </span>
            ))}
          </div>
        )}
        <SmimeComposeBar c={c} check={smimeCheck.check} block={smimeCheck.block} />
        <div className="modal-foot">
          <label className="btn attach-btn">
            <svg className="icon sm"><use href="#i-clip" /></svg> {t('compose.attach.add')}
            <input
              type="file"
              multiple
              hidden
              disabled={sending}
              onChange={(e) => {
                if (e.target.files?.length) void addAttachments(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
          <div className="tpl-menu">
            <button
              type="button"
              disabled={sending}
              onClick={() => {
                if (!tplOpen) void reloadTemplates()
                setTplOpen((v) => !v)
              }}
              title={t('compose.template.menuTitle')}
              aria-expanded={tplOpen}
            >
              <svg className="icon sm"><use href="#i-file" /></svg> {t('compose.template.button')}
            </button>
            {tplOpen && (
              <div className="menu tpl-dropdown" role="menu">
                {templates.length === 0 && <div className="move-item dim">{t('compose.template.empty')}</div>}
                {templates.map((tpl) => (
                  <div key={tpl.name} className="move-item tpl-item" role="menuitem">
                    <button
                      type="button"
                      className="tpl-name"
                      disabled={sending}
                      onClick={() => insertTemplate(tpl)}
                      title={tpl.subject ? t('compose.template.subjectTip', { subject: tpl.subject }) : undefined}
                    >
                      {tpl.name}
                    </button>
                    <button
                      type="button"
                      className="tpl-del"
                      disabled={sending}
                      title={t('action.delete')}
                      aria-label={t('compose.template.deleteAria', { name: tpl.name })}
                      onClick={() => void deleteTemplate(tpl.name)}
                    >
                      <svg className="icon sm"><use href="#i-x" /></svg>
                    </button>
                  </div>
                ))}
                <div className="menu-sep" role="separator" />
                <button type="button" className="menu-item" disabled={sending} onClick={() => void saveAsTemplate()}>
                  <svg className="icon sm"><use href="#i-plus" /></svg> {t('compose.template.saveCurrent')}
                </button>
                <div className="tpl-vars" title={t('compose.template.varsTip')}>
                  {t('compose.template.vars', { vars: templateVarNames().map((v) => `{{${v}}}`).join(' ') })}
                </div>
              </div>
            )}
          </div>
          <label className="followup-pick" title={t('compose.followup.tip')}>
            <svg className="icon sm"><use href="#i-bell" /></svg>
            <select
              aria-label={t('compose.followup.aria')}
              disabled={sending}
              value={c.followupDays ?? 0}
              onChange={(e) => setComposer({ ...c, followupDays: Number(e.target.value) || undefined })}
            >
              <option value={0}>{t('compose.followup.none')}</option>
              <option value={1}>{t('compose.followup.afterDays', { count: 1 })}</option>
              <option value={3}>{t('compose.followup.afterDays', { count: 3 })}</option>
              <option value={7}>{t('compose.followup.afterWeeks', { count: 1 })}</option>
              <option value={14}>{t('compose.followup.afterWeeks', { count: 2 })}</option>
            </select>
          </label>
          <span className="hint" aria-hidden="true" />
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            disabled={sending}
            onClick={() => closeComposer(true)}
            title={t('compose.discard.tip')}
            aria-label={t('compose.discard.aria')}
          >
            <svg className="icon"><use href="#i-trash" /></svg>
          </button>
          <div className="send-split">
            <button className="primary" disabled={sendLocked} onClick={() => void send()} title={smimeCheck.block ?? t('compose.send.tip')} aria-keyshortcuts="Meta+Enter">
              {t('compose.send.button')}
            </button>
            <button className="primary send-later-toggle" disabled={sendLocked} title={smimeCheck.block ?? t('compose.send.later')} aria-label={t('compose.send.later')} aria-haspopup="menu" aria-expanded={laterOpen} onClick={() => setLaterOpen((v) => !v)}>
              <svg className="icon sm"><use href="#i-clock" /></svg>
            </button>
            {laterOpen && (
              <div className="menu send-later-menu">
                <div className="menu-label">{t('compose.send.later')}</div>
                {laterOptions.map((o) => (
                  <div key={o.key} className="move-item" onClick={() => { setLaterOpen(false); void send(o.at(), o.key) }}>
                    {o.label}
                  </div>
                ))}
                <div className="send-later-custom">
                  <input type="datetime-local" disabled={sending} value={customAt} onChange={(e) => setCustomAt(e.target.value)} />
                  <button className="primary" disabled={!customAt || sending} onClick={scheduleCustom}>{t('compose.send.schedule')}</button>
                </div>
              </div>
            )}
          </div>
        </div>
    </Modal>
  )
}
