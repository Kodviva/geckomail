// Mağaza — Yazma: taslak kurtarma, imza, gönderim, ekler.
import DOMPurify from 'dompurify'
import type { DraftOut, MessageRow } from '../../../shared/rpc'
import { fmtDateTime, t } from '../../../shared/i18n'

import { forwardSubject, replySubject } from '../../../shared/subjectPrefix'
import { platform, UploadError } from '../platform'
import { rpc } from '../rpcClient'
import { draftIsSensitive, smimeRequest } from '../smimeCompose'
import type { ComposerAttachment, ComposerState, GetState, SetState, State } from './types'

const DRAFT_KEY = 'gecko-draft'

function saveDraft(c: ComposerState | null): void {
  try {
    // şifrelenecek ya da şifreli iletiden alıntılı gövde localStorage'a inmez; önceki kayıt da silinir
    if (!c || draftIsSensitive(c)) return localStorage.removeItem(DRAFT_KEY)
    const { attachments: _a, restored: _r, ...rest } = c
    // ekler localStorage'a sığmaz — sadece metin alanları kurtarılır
    localStorage.setItem(DRAFT_KEY, JSON.stringify(rest))
  } catch {
    /* localStorage dolu/kapalıysa taslak kaydı sessizce atlanır */
  }
}

/** Web çıkışı: gönderilmemiş taslak cihazda kalmaz */
export function clearDraft(): void {
  saveDraft(null)
}

/** Gönderim kimliği (UUID). randomUUID yalnız güvenli bağlamda var; yoksa aynı biçim rastgele baytlardan */
export function newSendId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function loadDraft(): Omit<ComposerState, 'attachments'> | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    return raw ? (JSON.parse(raw) as Omit<ComposerState, 'attachments'>) : null
  } catch {
    return null
  }
}

function withSignature(text: string, sig: string | null | undefined): string {
  return sig && sig.trim() ? `${text}\n\n--\n${sig}` : text
}

function formatAddr(m: MessageRow): string {
  return m.fromName || m.fromAddr || ''
}

export const composeSlice = (set: SetState, get: GetState) =>
  ({
    openComposer(mode) {
      const { accounts, messages, selectedMessageId, body, selectedAccountIds } = get()
      if (!accounts.length) return
      if (!get().contacts.length) void get().refreshContacts() // otomatik-tamamlama için bir kez yükle
      if (mode === 'new') {
        // kaydedilmemiş taslak varsa onu kurtar
        const saved = loadDraft()
        if (saved && (saved.to || saved.subject || saved.text.trim())) {
          // eski taslak kayıtlarında rich/html olmayabilir — spread sonrası normalize
          set({
            composer: {
              ...saved,
              rich: saved.rich ?? false,
              html: saved.html ?? '',
              bcc: saved.bcc ?? '',
              attachments: [],
              restored: true
            }
          })
          get().toast(t('compose.draft.recovered'), 'info')
          return
        }
        const fromId =
          selectedAccountIds?.length === 1 ? selectedAccountIds[0] : (accounts.find((a) => a.enabled)?.id ?? accounts[0].id)
        const acc = accounts.find((a) => a.id === fromId)
        set({
          composer: {
            fromAccountId: fromId,
            to: '',
            cc: '',
            bcc: '',
            subject: '',
            text: withSignature('', acc?.mySignature),
            rich: false,
            html: '',
            attachments: []
          }
        })
        return
      }
      const msg = messages.find((m) => m.id === selectedMessageId)
      if (!msg) return
      const quotedSource = body?.state === 'ready' ? (body.textPlain ?? '') : ''
      const quoted = quotedSource
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n')
      const date = fmtDateTime(msg.date)
      const header = `\n\n${t('compose.quote.header', { date, sender: formatAddr(msg) })}\n${quoted}`
      const subjectBase = msg.subject ?? ''
      const to = mode === 'forward' ? '' : (msg.fromAddr ?? '')
      let cc = ''
      if (mode === 'replyAll' && msg.toJson) {
        try {
          const others = (JSON.parse(msg.toJson) as Array<{ address?: string }>)
            .map((a) => a.address)
            .filter((a): a is string => !!a)
            .filter((a) => !get().accounts.some((acc) => acc.email === a.toLowerCase()))
          cc = others.join(', ')
        } catch {
          /* to listesi bozuksa cc boş kalır */
        }
      }
      const replyAcc = accounts.find((a) => a.id === msg.accountId)
      // gövde henüz gelmemiş olabilir: satırdaki tür de yeter, şifreli içerik düz yanıta sızmasın
      const fromEncrypted = msg.smimeKind === 'encrypted' || (body?.state === 'ready' && !!body.smime && body.smime.enc !== 'none')
      set({
        composer: {
          fromAccountId: msg.accountId,
          to,
          cc,
          bcc: '',
          // iletme öneki arayüz dilinde (İlt/WG/TR …); yanıt her dilde "Re:"
          subject: mode === 'forward' ? forwardSubject(subjectBase) : replySubject(subjectBase),
          text: withSignature(
            mode === 'forward' ? `\n\n${t('compose.quote.forwarded')}\n${quotedSource}` : header,
            replyAcc?.mySignature
          ),
          rich: false,
          html: '',
          inReplyTo: mode === 'forward' ? undefined : (msg.messageId ?? undefined),
          references: mode === 'forward' ? undefined : (msg.messageId ?? undefined),
          attachments: [],
          mode,
          ...(fromEncrypted ? { smimeSign: true, smimeEncrypt: true, smimeSensitive: true } : {})
        }
      })
    },

    setComposer(c) {
      set({ composer: c })
      // kasa hesabından yazılan mail diske (localStorage) düz metin inmez (R21) — taslak kurtarma yok
      const secure = c ? !!get().accounts.find((a) => a.id === c.fromAccountId)?.secure : false
      saveDraft(c && !secure && (c.to || c.subject || c.text.trim()) ? c : null)
    },

    closeComposer(discard = false) {
      const c = get().composer
      set({ composer: null })
      const hasContent = !!c && !!(c.to || c.subject || c.text.trim() || c.attachments.length)
      if (!hasContent) {
        saveDraft(null)
        return
      }
      const secure = !!get().accounts.find((a) => a.id === c!.fromAccountId)?.secure
      const sensitive = draftIsSensitive(c!)
      if ((secure || sensitive) && !discard) {
        // kasa hesabının ve şifreli iletinin taslağı diske yazılmaz: kapatmak kaybetmek demek — sor
        if (!window.confirm(t(secure ? 'compose.draft.vaultCloseConfirm' : 'smime.compose.closeConfirm'))) {
          set({ composer: c })
          return
        }
        return
      }
      if (!discard) {
        // taslak localStorage'da zaten güncel (setComposer her değişiklikte yazar) — sadece pencere kapanır
        get().toast(c!.attachments.length ? t('compose.draft.savedNoAttachments') : t('compose.draft.saved'), 'info', {
          label: t('action.delete'),
          fn: () => saveDraft(null)
        })
        return
      }
      saveDraft(null)
      get().toast(t('compose.draft.discarded'), 'info', {
        label: t('compose.common.undo'),
        fn: () => get().setComposer(c)
      })
    },

    async send(sendAt?: number, preset?: string) {
      const composed = get().composer
      if (!composed || get().sending) return
      if (!composed.to.trim()) {
        get().toast(t('compose.send.noRecipient'), 'error')
        return
      }
      // aynı ileti aynı kimlikle: zaman aşımından sonra "Gönder"e yeniden basmak ikinci mail olmaz. Taslakla saklanır
      // (sayfa yenilense de aynı). Başarılı gönderimde oluşturucuyla biter; op:failed kimliği yeniler (session.ts)
      const c = composed.clientSendId ? composed : { ...composed, clientSendId: newSendId() }
      if (c !== composed) get().setComposer(c)
      // göreli hazır seçenek (ör. "1 saat sonra"): ilk denemedeki zaman yeniden denemede de aynı gider
      if (sendAt && preset) {
        if (c.sendAtAttempt?.preset === preset && c.sendAtAttempt.at >= Date.now()) sendAt = c.sendAtAttempt.at
        else get().setComposer({ ...c, sendAtAttempt: { preset, at: sendAt } })
      }
      // zengin metin: gövde HTML gider, düz metin alternatifi türetilir.
      // yapıştırma anında sanitize ediliyor ama gönderimde bir kez daha (derinlemesine savunma)
      let text = c.text
      let html: string | undefined
      if (c.rich && c.html.trim()) {
        html = DOMPurify.sanitize(c.html, { FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'meta', 'base', 'link'] })
        const el = document.createElement('div')
        el.innerHTML = html
        text = el.innerText
      }
      const draft: DraftOut = {
        accountId: c.fromAccountId,
        to: c.to,
        cc: c.cc || undefined,
        bcc: c.bcc || undefined,
        subject: c.subject,
        text,
        html,
        inReplyTo: c.inReplyTo,
        references: c.references,
        attachments: c.attachments.length
          ? c.attachments.map((a) =>
              a.uploadId
                ? { filename: a.filename, mime: a.mime, size: a.size, uploadId: a.uploadId }
                : { filename: a.filename, mime: a.mime, size: a.size, data: a.data }
            )
          : undefined
      }
      set({ sending: true })
      try {
        const smime = smimeRequest(c)
        await rpc.call('sendMail', { draft, sendAt, followupDays: c.followupDays || undefined, closeFollowupId: c.closeFollowupId, clientSendId: c.clientSendId, ...(smime ? { smime } : {}) })
        set({ composer: null })
        saveDraft(null)
        // kasa hesabında zamanlanmış gönderi: gönderim anında kasa kilitliyse şifre bulunamaz → başarısız
        const secureAcc = sendAt ? get().accounts.find((a) => a.id === draft.accountId)?.secure : false
        const when = sendAt ? fmtDateTime(sendAt, { dateStyle: 'medium', timeStyle: 'short' }) : ''
        get().toast(
          sendAt
            ? t(secureAcc ? 'compose.send.scheduledVault' : 'compose.send.scheduled', { when })
            : t('compose.send.queued'),
          'info'
        )
      } catch (e) {
        get().toast(String((e as Error).message), 'error')
      } finally {
        set({ sending: false })
      }
    },

    async addAttachments(files) {
      const c = get().composer
      if (!c) return
      const list = [...files]
      // sınır okumadan/yüklemeden önce (dosya boyutu File'da hazır)
      const total = [...c.attachments, ...list].reduce((n, a) => n + a.size, 0)
      if (total > 25_000_000) {
        get().toast(t('compose.attach.tooLarge'), 'error')
        return
      }
      const added: ComposerAttachment[] = []
      for (const f of list) {
        const mime = f.type || 'application/octet-stream'
        if (platform.uploadFile) {
          // web: içerik sunucuya HTTP ile gider, taslakta yalnız kimliği kalır
          try {
            added.push({ filename: f.name, mime, size: f.size, uploadId: await platform.uploadFile(f) })
          } catch (e) {
            const tooLarge = e instanceof UploadError && e.status === 413
            // bu eklemede önceden yüklenenler de taslağa girmeyecek: sunucuda kotayı tutmasınlar
            for (const a of added) if (a.uploadId) void platform.discardUpload?.(a.uploadId)
            get().toast(tooLarge ? t('compose.attach.tooLarge') : t('compose.attach.uploadFailed', { name: f.name }), 'error')
            return
          }
        } else {
          const data = new Uint8Array(await f.arrayBuffer())
          added.push({ filename: f.name, mime, size: data.byteLength, data })
        }
      }
      // yükleme sürerken yazma penceresi kapanmış ya da değişmiş olabilir: güncel hâline eklenir
      const cur = get().composer
      if (!cur) {
        for (const a of added) if (a.uploadId) void platform.discardUpload?.(a.uploadId)
        return
      }
      get().setComposer({ ...cur, attachments: [...cur.attachments, ...added] })
    },

    removeAttachment(index) {
      const c = get().composer
      if (!c) return
      const gone = c.attachments[index]
      if (gone?.uploadId) void platform.discardUpload?.(gone.uploadId)
      get().setComposer({ ...c, attachments: c.attachments.filter((_, i) => i !== index) })
    }
  }) satisfies Partial<State>
