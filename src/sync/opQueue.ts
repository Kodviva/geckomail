import { createHmac } from 'crypto'
import { rmSync } from 'fs'
import type { DraftOut, FolderKind } from '../shared/rpc'
import type { AccountRow, FolderRow, OpRow, Queries } from './db/queries'
import { OPTIMISTIC_HIDE_OPS } from './db/q/types'
import type { Scheduler } from './scheduler'
import { fetchBody } from './bodyFetch'
import { classifyError } from './imapClient'
import { ensureFolders, invalidateFolderList, pollFolder } from './imapPoll'
import { movedArrivals } from './movedArrivals'
import { LoginDeniedError, OfflineError, PoolDeferred } from './net/sessionPool'
import { prepareSmimeParts } from './smime/build'
import { SmimeBlockedError, SmimeLockedError, SmimePendingError, SmimeNoIdentityError } from './smime/errors'
import type { SigEvaluator } from './smime/open'
import { safeFetch, webhookNetPolicy } from './net/safeFetch'
import { isVaultUnlocked } from './vault/state'
import { composeRaw, newMessageId, smtpSendRaw, type OutboxAttachment, type SendMeta } from './smtpSend'
import { t } from '../shared/i18n'
import { tProcess } from './sessionLocale'
import { forwardSubject } from '../shared/subjectPrefix'

const MAX_ATTEMPTS = 5
const CRL_PENDING_WAIT_MS = 60_000
const DRAIN_INTERVAL_MS = 3000
const WEBHOOK_CONCURRENCY = 4 // CFG.pollSlotsPerHost emsaliyle aynı — küçük ofis NAT'ı gibi görün
const OFFLINE_DEFER_MS = 30_000 // internet gelince scheduler da aynı aralıkta yoklar
const LOGIN_DENIED_DEFER_MS = 5 * 60_000
const STOP_DRAIN_MS = 8000 // sunucu 10 sn içinde kapanmazsa zorla çıkar

export interface OpQueueEvents {
  emitOpFailed(accountId: number, kind: string, error: string, draft?: DraftOut, opId?: number, partial?: boolean, senderId?: number): void
  emitChanged(accountId: number): void
  emitAutomationLogged(): void
  /** imzalı gövde kural yolunda indirilirse: güven kararı motorun deposuyla */
  smimeEvaluate?: SigEvaluator
}

interface StoreFlagsPayload {
  folderPath: string
  uids: number[]
  uidValidity?: number // kuyruğa girerken klasörün değeri (R34)
  seen?: boolean
  flagged?: boolean
}

interface TrashPayload {
  folderPath: string
  uids: number[]
  uidValidity?: number // kuyruğa girerken klasörün değeri (R34)
}

interface AppendSentPayload {
  rawB64: string
}

interface SmtpSendPayload {
  draft: DraftOut
  /** taslağı geri alabilecek tek kullanıcı; kural ve zamanlayıcı gönderimlerinde yok */
  senderId?: number
  attachments?: OutboxAttachment[]
  // kimlik kuyruğa alınırken, tarih ilk denemede sabitlenir ve payload'a yazılır (yeniden deneme = aynı mail)
  meta?: Partial<SendMeta>
  /** S/MIME: imza userId'nin anahtarıyla atılır, yeniden deneyen başkası olsa da */
  smime?: { sign: boolean; encrypt: boolean; userId: number }
  /** gönderilmiş parça sayısı: yeniden denemede atlanır, Bcc alıcısı iki kopya almaz */
  smimeSent?: number
}

interface OutgoingPart {
  raw(): Promise<Buffer>
  envelopeTo?: string[]
  forSent: boolean
}

const smimeKey = (opId: number, p: SmtpSendPayload): string => `${opId}:${p.meta?.messageId ?? ''}`

interface MoveNamedPayload {
  folderPath: string
  uids: number[]
  uidValidity?: number // kuyruğa girerken klasörün değeri (R34)
  targetFolderName: string
}

interface ForwardPayload {
  messageId: number
  to: string
}

interface CallWebhookPayload {
  webhookId: number
  body: Record<string, unknown>
}

const WEBHOOK_TIMEOUT_MS = 10_000

export class OpQueue {
  private timer: ReturnType<typeof setInterval> | null = null
  private draining = false
  private stopping = false
  private turn: Promise<void> | null = null
  private smtpBusy = false
  private webhookInFlight = 0
  /** anahtar op + Message-ID: op kimliği yeniden kullanılır (AUTOINCREMENT yok), yeni ileti eski ilerlemeyi devralmaz */
  private readonly smimeProgress = new Map<string, number>()
  /** Kasa kilitliyken mühürlenemeyen Gönderilenler kopyaları; yalnız bellekte */
  private readonly heldSent: { accountId: number; email: string; rawB64: string }[] = []

  constructor(
    private q: Queries,
    private scheduler: Scheduler,
    private creds: Map<number, string>,
    private attachDir: string,
    private ev: OpQueueEvents,
    /** Webhook ağ politikası; bilinmiyorsa kapalı olan */
    private mode: 'desktop' | 'server' = 'server'
  ) {}

  start(): void {
    this.q.resetRunningOps(t('sync.op.sendUncertain'))
    this.timer = setInterval(() => void this.drain(), DRAIN_INTERVAL_MS)
  }

  /** Yeni tur başlamaz, başlamamış op sıraya döner, gönderilmekte olan biter: DB kapanınca yarım kalan gönderim açılışta
   *  belirsiz sayılırdı. Süre dolarsa beklemeyi bırakır (satır 'running' kalır, açılış karar verir) */
  async stop(waitMs = STOP_DRAIN_MS): Promise<void> {
    this.stopping = true
    if (this.timer) clearInterval(this.timer)
    if (!this.turn) return
    let timeout: ReturnType<typeof setTimeout> | undefined
    await Promise.race([this.turn.catch(() => {}), new Promise<void>((r) => (timeout = setTimeout(r, waitMs)))])
    clearTimeout(timeout)
  }

  kick(): void {
    setTimeout(() => void this.drain(), 50)
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopping) return
    this.draining = true
    this.turn = this.drainTurn()
    try {
      await this.turn
    } finally {
      this.draining = false
      this.turn = null
    }
  }

  /** Kapanışta sıradaki op başlamaz. true: `list`in `i`. satırından sonrası sıraya döndü */
  private haltAt(list: OpRow[], i: number): boolean {
    if (!this.stopping) return false
    this.q.opRelease(list.slice(i).map((o) => o.id))
    return true
  }

  private async drainTurn(): Promise<void> {
    this.flushHeldSent()
    // sahiplenilen satır çalıştırılır ya da sıraya geri verilir: webhook şeridi boş yuva kadar alır
    const ops = this.q.claimDueOps(Date.now(), 30)
    let webhookOps: OpRow[]
    try {
      webhookOps = this.q.claimDueWebhookOps(Date.now(), Math.max(0, WEBHOOK_CONCURRENCY - this.webhookInFlight))
    } catch (e) {
      this.q.opRelease(ops.map((o) => o.id)) // 'running' kalırlarsa yeniden başlatmaya dek işlenmezler
      throw e
    }
    if (!ops.length && !webhookOps.length) return
    const smtpOps = ops.filter((o) => o.kind === 'smtp_send')
    const imapOps = ops.filter((o) => o.kind !== 'smtp_send')

    const byAccount = new Map<number, OpRow[]>()
    for (const op of imapOps) {
      const list = byAccount.get(op.account_id) ?? []
      list.push(op)
      byAccount.set(op.account_id, list)
    }
    const jobs: Promise<void>[] = []
    for (const [accountId, list] of byAccount) {
      jobs.push(
        this.scheduler
          .enqueueInteractive(accountId, async (client) => {
            for (const [i, op] of list.entries()) {
              if (this.haltAt(list, i)) break
              await this.runImapOp(client, op)
            }
          })
          .catch((e) => {
            // governor ertelemesi (soğuma/hız): deneme hakkı yakmadan bekleme sonrasına at
            if (e instanceof PoolDeferred) {
              for (const op of list) this.q.opDefer(op.id, e.message, Date.now() + Math.max(5000, e.waitMs))
              return
            }
            // internet yok ya da hesap oturum açamıyor (parola bekleniyor, kasa kilitli): op'un hatası değil, deneme yanmaz
            if (e instanceof OfflineError || e instanceof LoginDeniedError) {
              const wait = e instanceof OfflineError ? OFFLINE_DEFER_MS : LOGIN_DENIED_DEFER_MS
              for (const op of list) this.q.opDefer(op.id, e.message, Date.now() + wait)
              return
            }
            // bağlantı kurulamadı: tüm grubun denemesini ertele
            for (const op of list) this.retryOrFail(op, String((e as Error)?.message ?? e))
          })
      )
    }
    if (smtpOps.length && !this.smtpBusy) {
      this.smtpBusy = true
      jobs.push(
        (async () => {
          for (const [i, op] of smtpOps.entries()) {
            if (this.haltAt(smtpOps, i)) break
            await this.runSmtpOp(op)
          }
        })().finally(() => (this.smtpBusy = false))
      )
    } else {
      this.q.opRelease(smtpOps.map((o) => o.id))
    }
    // Webhook'lar: IMAP scheduler'dan ve smtpBusy'den bağımsız üçüncü şerit — hesaba
    // bağlı değil, eşzamanlı teslimat gerekir (hesap-başına-seri değil).
    for (const op of webhookOps) {
      this.webhookInFlight++
      jobs.push(this.runWebhookOp(op).finally(() => this.webhookInFlight--))
    }
    await Promise.allSettled(jobs)
  }

  private async runImapOp(client: import('imapflow').ImapFlow, op: OpRow): Promise<void> {
    let movedTo: string | undefined
    try {
      const payload = JSON.parse(op.payload_json) as unknown
      switch (op.kind) {
        case 'store_flags': {
          const p = payload as StoreFlagsPayload
          const lock = await client.getMailboxLock(p.folderPath)
          this.assertUidValidity(client, p, lock)
          try {
            const range = p.uids.join(',')
            if (p.seen !== undefined) {
              if (p.seen) await client.messageFlagsAdd(range, ['\\Seen'], { uid: true })
              else await client.messageFlagsRemove(range, ['\\Seen'], { uid: true })
            }
            if (p.flagged !== undefined) {
              if (p.flagged) await client.messageFlagsAdd(range, ['\\Flagged'], { uid: true })
              else await client.messageFlagsRemove(range, ['\\Flagged'], { uid: true })
            }
          } finally {
            lock.release()
          }
          break
        }
        case 'trash': {
          const p = payload as TrashPayload
          // kalıcı silme yalnız ileti zaten Çöp Kutusu'ndaysa: klasör bulunamadı diye posta yok olmaz
          const inTrash = this.q.getFolders(op.account_id).find((f) => f.path === p.folderPath)?.kind === 'trash'
          const trash = inTrash ? null : await this.trashFolder(client, op.account_id)
          const lock = await client.getMailboxLock(p.folderPath)
          this.assertUidValidity(client, p, lock)
          try {
            const range = p.uids.join(',')
            if (trash) {
              // ImapFlow: MOVE varsa MOVE, yoksa COPY+STORE+EXPUNGE kendisi uygular
              await client.messageMove(range, trash.path, { uid: true })
            } else {
              await client.messageDelete(range, { uid: true })
            }
          } finally {
            lock.release()
          }
          break
        }
        case 'move': {
          const p = payload as TrashPayload & { targetPath: string }
          await this.moveTracked(client, op.account_id, p, p.targetPath)
          movedTo = p.targetPath
          break
        }
        case 'move_special': {
          const p = payload as TrashPayload & { special: 'archive' | 'junk' }
          let target = p.special === 'junk' ? this.q.getFolderByKind(op.account_id, 'junk') : this.q.getFolderByKind(op.account_id, 'archive')
          if (!target && p.special === 'archive') {
            // Arşiv klasörü yoksa oluştur — cPanel'de genelde yoktur
            await client.mailboxCreate('Archive').catch(() => {})
            const id = this.q.upsertFolder(op.account_id, 'Archive', 'archive')
            target = this.q.getFolderById(id) ?? undefined
          }
          if (!target) throw new Error(t(p.special === 'junk' ? 'sync.op.spamFolderMissing' : 'sync.op.archiveCreateFailed'))
          await this.moveTracked(client, op.account_id, p, target.path)
          if (this.q.sieveWatchedPaths(op.account_id).includes(target.path)) movedTo = target.path
          break
        }
        case 'move_named': {
          // move_special'ın Archive-oluşturma bloğunun genellemesi — kural motoru bir kuralı
          // birden çok hesaba uygulayabildiğinden isim çalışma anında hesap başına çözülür.
          const p = payload as MoveNamedPayload
          const wanted = p.targetFolderName.trim().toLowerCase()
          let target = this.q
            .getFolders(op.account_id)
            .find((f) => f.path.replace(/^INBOX\.?/i, '').toLowerCase() === wanted || f.path.toLowerCase() === wanted)
          if (!target) {
            await client.mailboxCreate(p.targetFolderName).catch(() => {})
            const id = this.q.upsertFolder(op.account_id, p.targetFolderName, 'other')
            target = this.q.getFolderById(id) ?? undefined
          }
          if (!target) throw new Error(t('sync.op.folderCreateFailed', { folder: p.targetFolderName }))
          await this.moveTracked(client, op.account_id, p, target.path)
          if (this.q.sieveWatchedPaths(op.account_id).includes(target.path)) movedTo = target.path
          break
        }
        case 'forward': {
          // İki aşamalı: gövdeyi (yoksa) getir, sonra mevcut smtp_send'i değiştirmeden yeniden
          // kuyruğa al — SMTP tarafı zaten kendi kibarlık kapısına (smtpBusy) sahip.
          const p = payload as ForwardPayload
          const msg = this.q.getMessage(p.messageId)
          if (!msg) break // kural tetiklendikten sonra yerelden silinmiş/gizlenmiş olabilir
          const row = this.q.getAccountRow(op.account_id)
          if (!row) break
          let bodyRow = msg.smimeKind === 'encrypted' ? undefined : this.q.getBodyRow(p.messageId)
          if (!bodyRow && msg.smimeKind !== 'encrypted') {
            await fetchBody(this.q, row, msg, client, this.attachDir, this.ev.smimeEvaluate)
            bodyRow = this.q.getBodyRow(p.messageId)
          }
          // şifreli içerik kurala kapalı: anahtar kişiye aittir, boş ileti de gönderilmez
          if (this.q.getMessage(p.messageId)?.smimeKind === 'encrypted') {
            this.q.insertRuleLog({ kind: 'rule', refId: null, accountId: op.account_id, messageId: p.messageId, summary: tProcess('sync.smime.forwardSkipped'), ok: false })
            this.ev.emitAutomationLogged()
            break
          }
          const quoted = (bodyRow?.text_plain ?? '')
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n')
          const subjectBase = msg.subject ?? ''
          const draft: DraftOut = {
            accountId: op.account_id,
            to: p.to,
            subject: forwardSubject(subjectBase),
            text: `\n\n---------- ${t('sync.forward.header')} ----------\n${quoted}`
          }
          this.q.enqueueOp(op.account_id, 'smtp_send', { draft, attachments: [], meta: { messageId: newMessageId(row.email), autoForwarded: true } })
          break
        }
        case 'mark_all_seen': {
          const { folderKind } = JSON.parse(op.payload_json) as { folderKind: FolderKind }
          const folder = this.q.getFolderByKind(op.account_id, folderKind)
          if (folder) {
            const lock = await client.getMailboxLock(folder.path)
            try {
              await client.messageFlagsAdd('1:*', ['\\Seen'], { uid: true })
            } finally {
              lock.release()
            }
          }
          break
        }
        case 'append_sent': {
          const p = payload as AppendSentPayload
          const sent = this.q.getFolderByKind(op.account_id, 'sent')
          if (sent) {
            await client.append(sent.path, Buffer.from(p.rawB64, 'base64'), ['\\Seen'])
            this.scheduler.pollSoon(op.account_id, 2000)
          }
          // Sent klasörü yoksa sessizce geç: mail zaten gönderildi
          break
        }
        default:
          throw new Error(t('sync.op.unknown', { kind: op.kind }))
      }
      this.q.opDone(op.id)
    } catch (e) {
      const err = e as Error & { permanent?: boolean; uidValidityChanged?: boolean }
      if (err?.uidValidityChanged) {
        const p = JSON.parse(op.payload_json) as { folderPath?: string }
        const f = this.q.getFolders(op.account_id).find((x) => x.path === p.folderPath)
        if (f) this.q.resetFolder(f.id) // yerel görünüm sunucudan yeniden kurulsun
      }
      this.retryOrFail(op, String(err?.message ?? e), undefined, !!err?.permanent)
      return
    }
    // op'un try'ının dışında; hata yutulur: yukarı çıksa grubun tamamı (bitenler dahil) yeniden denenirdi
    if (movedTo) await this.syncMoveTarget(client, op.account_id, movedTo).catch(() => {})
  }

  /** Çöp Kutusu: yerelde yoksa önce klasör listesi tazelenir (yerel adlı ya da sonradan açılmış olabilir), sonra Archive gibi
   *  oluşturulur. Oluşturulamazsa hata op'a döner: yeniden denenir, kalıcı silmeye düşmez */
  private async trashFolder(client: import('imapflow').ImapFlow, accountId: number): Promise<FolderRow> {
    const known = this.q.getFolderByKind(accountId, 'trash')
    if (known) return known
    const row = this.q.getAccountRow(accountId)
    if (row) {
      invalidateFolderList(this.q, accountId)
      await ensureFolders(this.q, row, client)
      const listed = this.q.getFolderByKind(accountId, 'trash')
      if (listed) return listed
    }
    const made = await client.mailboxCreate('Trash')
    const created = this.q.getFolderById(this.q.upsertFolder(accountId, made.path, 'trash'))
    if (!created) throw new Error(t('sync.op.folderCreateFailed', { folder: 'Trash' }))
    return created
  }

  /** Taşınan ileti hedefte yeni posta sayılmaz. Kural taşıması da kaydolur: hedef izleniyorsa kural orada ikinci kez çalışırdı.
   *  Normal poll hedefi taşıma biter bitmez okuyabilir: Message-ID kaydı taşımadan önce açılır */
  private async moveTracked(client: import('imapflow').ImapFlow, accountId: number, p: TrashPayload, targetPath: string): Promise<void> {
    const lock = await client.getMailboxLock(p.folderPath)
    this.assertUidValidity(client, p, lock)
    movedArrivals.expect(accountId, targetPath, this.q.messageIdsByUids(accountId, p.folderPath, p.uids))
    try {
      const res = await client.messageMove(p.uids.join(','), targetPath, { uid: true })
      movedArrivals.resolve(accountId, targetPath, p.uids, res ? res.uidMap : undefined)
    } catch (e) {
      movedArrivals.cancel(accountId, targetPath, p.uids)
      throw e
    } finally {
      lock.release()
    }
  }

  /** Taşınan iletiler hedefte hemen görünsün: düzenli poll elle açılan klasörleri kapsamaz. Taşınan iletiler yeni posta sayılmaz
   *  (movedArrivals): kuralları ve bildirimi tetiklemez; aynı aralıktaki gerçek posta yine yeni sayılır. Taşıma tamamlandı,
   *  eşitleme hatası op'u yeniden denetmez */
  private async syncMoveTarget(client: import('imapflow').ImapFlow, accountId: number, path: string): Promise<void> {
    const folder = this.q.getFolders(accountId).find((f) => f.path === path)
    const row = this.q.getAccountRow(accountId)
    if (folder && row) await pollFolder(this.q, row, folder, client, 1).catch(() => {})
    this.ev.emitChanged(accountId)
  }

  // Kuyruğa girdiği andaki UIDVALIDITY ile sunucudaki farklıysa UID'ler başka mesajları gösterir:
  // işlemi kalıcı iptal et (yanlış mesajı silmek/taşımak yerine) — poll klasörü yeniden eşitler
  private assertUidValidity(client: import('imapflow').ImapFlow, p: { uidValidity?: number }, lock: { release(): void }): void {
    const mb = client.mailbox
    const current = mb && typeof mb !== 'boolean' && mb.uidValidity != null ? Number(mb.uidValidity) : null
    if (p.uidValidity != null && current != null && current !== p.uidValidity) {
      lock.release()
      throw Object.assign(new Error(t('sync.op.uidValidityChanged')), { permanent: true, uidValidityChanged: true })
    }
  }

  private async runSmtpOp(op: OpRow): Promise<void> {
    try {
      const payload = JSON.parse(op.payload_json) as SmtpSendPayload
      const { draft, attachments = [] } = payload
      // sahiplenildikten sonra kilitlendi: mühürlü op yazılamaz, deneme yakmadan sıraya döner
      if (payload.smime && !isVaultUnlocked()) {
        this.q.opRelease([op.id])
        return
      }
      const row = this.q.getAccountRow(op.account_id)
      const password = this.creds.get(op.account_id)
      if (!row || !password) throw new Error(t('sync.err.accountOrPasswordNotFound'))
      // SMTP login'i de IMAP ile aynı governor'dan geçer: IP engeli ikisini birden vurur
      const gov = this.scheduler.governorFor(row.smtp_host)
      const grant = gov.tryTakeLogin('interactive', true)
      if (!grant.ok) {
        const until = Date.now() + Math.max(5000, grant.waitMs)
        this.q.opDefer(op.id, t(grant.reason === 'rate' ? 'sync.op.sendQueued' : 'sync.op.sendDeferred'), until)
        return
      }
      // eski sürümden kalan op'lar kimliksiz olabilir: ilk denemede üret, kalıcı yaz
      if (!payload.meta?.messageId || !payload.meta.date) {
        payload.meta = { ...payload.meta, messageId: payload.meta?.messageId ?? newMessageId(row.email), date: payload.meta?.date ?? Date.now() }
        this.q.opSetPayload(op.id, payload)
      }
      const parts = await this.partsFor(op, payload, row)
      if (!parts) return
      const smtpHost = row.smtp_host.trim().toLowerCase()
      const progressKey = smimeKey(op.id, payload)
      const start = payload.smime ? Math.max(payload.smimeSent ?? 0, this.smimeProgress.get(progressKey) ?? 0) : 0
      for (let i = start; i < parts.length; i++) {
        // Bcc parçası ayrı oturumdur: governor yine geçilir, ilerleme payload'da kalır
        if (i > start) {
          const next = gov.tryTakeLogin('interactive', true)
          if (!next.ok) {
            this.q.opDefer(op.id, t(next.reason === 'rate' ? 'sync.op.sendQueued' : 'sync.op.sendDeferred'), Date.now() + Math.max(5000, next.waitMs))
            return
          }
        }
        const raw = await parts[i].raw()
        try {
          // alıcısız ana zarf (yalnız Bcc, "undisclosed:;"): SMTP'ye gitmez, Sent kopyası ve Bcc parçaları sürer
          if (parts[i].envelopeTo?.length !== 0) await smtpSendRaw(row, password, draft, raw, parts[i].envelopeTo)
          gov.onLoginSuccess()
          this.q.recordLoginAttempt(smtpHost, op.account_id, 'smtp', 'ok')
        } catch (e) {
          const kind = smtpErrorKind(e)
          // gönderim aşamasındaki hata: login başarılıydı (auto-ban sayacı açısından)
          const phase = (e as { phase?: string }).phase
          this.q.recordLoginAttempt(smtpHost, op.account_id, 'smtp', phase === 'send' ? 'ok' : kind === 'uncertain' ? 'net' : kind)
          const ev = gov.onLoginFailure(kind === 'uncertain' ? 'net' : kind)
          if (ev?.first) console.warn(`sync: ${row.smtp_host} SMTP bağlantılarını reddediyor — soğuma`)
          // hatalı şifreyle tekrar tekrar denemek fail2ban'in tetikleyicisidir: auth hatası tek seferde kalıcı
          if (kind === 'auth') throw Object.assign(e as Error, { permanent: true })
          // mail gönderilirken bağlantı koptu: alıcıya ulaşmış olabilir — otomatik deneme çift mail üretir,
          // karar kullanıcının (taslak geri verilir, Sent'e kopya yazılmaz)
          if (kind === 'uncertain') {
            throw Object.assign(
              new Error(t('sync.op.sendUncertain')),
              { permanent: true }
            )
          }
          throw e
        }
        // gönderilen kopyayı Sent'e yaz (ekler raw'ın içinde); şifresiz hali hiç yazılmaz. Ana parça gider gitmez: sonraki Bcc
        // parçası başarısız olsa da teslim edilmiş ileti Gönderilenler'de kalır
        if (parts[i].forSent) this.enqueueSent(op.account_id, row.email, raw, !!payload.smime)
        if (payload.smime) this.saveProgress(op.id, payload, i + 1)
      }
      this.smimeProgress.delete(progressKey)
      this.q.opDone(op.id)
      this.cleanupOutbox(attachments)
      this.kick()
    } catch (e) {
      const err = e as Error & { permanent?: boolean }
      this.retryOrFail(op, String(err?.message ?? e), undefined, !!err?.permanent)
    }
  }

  /** Mühür gereken kopya kasa kilitliyken diske düz yazılmaz: açılana dek bellekte bekler. Süreç bu arada biterse ileti teslim
   *  edilmiştir, yalnız Gönderilenler kopyası kaybolur. */
  private enqueueSent(accountId: number, email: string, raw: Buffer, smime: boolean): void {
    if (this.q.getAccountRow(accountId)?.email !== email) return // gönderim hesaptan uzun sürdü: kimlik başkasının olabilir
    const seal = smime || this.q.isAccountSecure(accountId)
    const rawB64 = raw.toString('base64')
    if (seal && !isVaultUnlocked()) this.heldSent.push({ accountId, email, rawB64 })
    else this.q.enqueueOp(accountId, 'append_sent', { rawB64 }, { seal })
  }

  private flushHeldSent(): void {
    if (!this.heldSent.length || !isVaultUnlocked()) return
    for (const { accountId, email, rawB64 } of this.heldSent.splice(0)) {
      // satır kimliği yeniden kullanılmış olabilir: kopya yalnız aynı adresin Gönderilenler'ine gider
      if (this.q.getAccountRow(accountId)?.email === email) this.q.enqueueOp(accountId, 'append_sent', { rawB64 }, { seal: true })
    }
  }

  /** Hesap silinince bellekteki düz kopya da gider */
  dropHeldSent(accountId: number): void {
    for (let i = this.heldSent.length - 1; i >= 0; i--) if (this.heldSent[i].accountId === accountId) this.heldSent.splice(i, 1)
  }

  /** Gönderilen parça yeniden gönderilmez. Tur sırasında kasa kilitlendiyse mühürlü satır yazılamaz: ilerleme bellekte kalır. */
  private saveProgress(id: number, payload: SmtpSendPayload, sent: number): void {
    payload.smimeSent = sent
    try {
      this.q.opSetPayload(id, payload)
    } catch {
      this.smimeProgress.set(smimeKey(id, payload), sent)
    }
  }

  /** Düz gönderimde tek ham ileti. S/MIME'de kripto burada: kimlik ve alıcılar her denemede yeniden denetlenir.
   *  Kasa kilitliyse null: op deneme yakmadan sıraya döner, kasa açılınca sürer. */
  private async partsFor(op: OpRow, payload: SmtpSendPayload, row: AccountRow): Promise<OutgoingPart[] | null> {
    const { draft, attachments = [], smime } = payload
    const meta = payload.meta as SendMeta
    if (!smime) {
      const raw = await composeRaw(row, draft, attachments, meta)
      return [{ raw: async () => raw, forSent: true }]
    }
    try {
      return await prepareSmimeParts({ account: row, draft, attachments, meta, req: smime, deps: { q: this.q, now: Date.now } })
    } catch (e) {
      if (e instanceof SmimeLockedError) {
        this.q.opRelease([op.id])
        return null
      }
      if (e instanceof SmimePendingError) {
        this.q.opDefer(op.id, t('sync.smime.recipientPending'), Date.now() + CRL_PENDING_WAIT_MS)
        return null
      }
      if (e instanceof SmimeNoIdentityError) throw Object.assign(new Error(t('sync.smime.noIdentity')), { permanent: true })
      if (e instanceof SmimeBlockedError) throw Object.assign(new Error(t('sync.smime.recipientBlocked')), { permanent: true })
      throw e
    }
  }

  private async runWebhookOp(op: OpRow): Promise<void> {
    try {
      const { webhookId, body } = JSON.parse(op.payload_json) as CallWebhookPayload
      const webhook = this.q.getWebhookById(webhookId)
      if (!webhook || !webhook.enabled) {
        this.q.opDone(op.id) // webhook silinmiş/kapatılmış — sessizce düş
        return
      }
      const raw = JSON.stringify(body)
      const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'GeckoMail-Webhook/1.0' }
      if (webhook.secret) headers['X-GeckoMail-Signature'] = `sha256=${createHmac('sha256', webhook.secret).update(raw).digest('hex')}`
      const res = await safeFetch(webhook.url, { method: 'POST', headers, body: raw, timeoutMs: WEBHOOK_TIMEOUT_MS, deadlineMs: WEBHOOK_TIMEOUT_MS, net: webhookNetPolicy(this.mode) })
      if (!res.ok) {
        const retryAfterHeader = String(res.headers['retry-after'] ?? '')
        const retryAfterMs = /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) * 1000 : undefined
        throw Object.assign(new Error(`HTTP ${res.status}`), { retryAfterMs })
      }
      this.q.opDone(op.id)
      this.q.touchWebhookDelivered(webhookId)
      this.q.insertRuleLog({ kind: 'webhook', refId: webhookId, accountId: op.account_id || null, messageId: null, summary: tProcess('sync.webhook.sent', { name: webhook.name }), ok: true })
      this.ev.emitAutomationLogged()
    } catch (e) {
      const err = e as Error & { retryAfterMs?: number }
      this.retryOrFail(op, String(err?.message ?? e), err?.retryAfterMs)
    }
  }

  /** Eski başarısız op'lar silinir; gönderimin ekleri satırla birlikte gider */
  pruneFailedOps(before: number): void {
    this.cleanupOutbox(this.q.pruneFailedOps(before).outboxFiles.map((path) => ({ path })))
  }

  private cleanupOutbox(attachments: { path: string }[]): void {
    for (const a of attachments) {
      try {
        rmSync(a.path)
      } catch {
        /* dosya zaten yoksa sorun değil */
      }
    }
  }

  /** Son durum: `op` satırı sahiplenildiği andaki kopyadır, smimeSent ondan sonra yazılır. Bellekteki ilerleme burada biter. */
  private partialSend(op: OpRow): boolean {
    if (op.kind !== 'smtp_send') return false
    try {
      const p = JSON.parse(this.q.getOp(op.id)?.payload_json ?? op.payload_json) as SmtpSendPayload
      if (!p.smime) return false
      const key = smimeKey(op.id, p)
      const sent = Math.max(p.smimeSent ?? 0, this.smimeProgress.get(key) ?? 0)
      this.smimeProgress.delete(key)
      return sent > 0
    } catch {
      return false
    }
  }

  private retryOrFail(op: OpRow, error: string, retryAfterMs?: number, permanent = false): void {
    if (permanent || op.attempts + 1 >= MAX_ATTEMPTS) {
      const partial = this.partialSend(op)
      if (partial) error = t('sync.smime.bccPartial', { error })
      this.q.opFailed(op.id, error)
      if (op.kind === 'call_webhook') {
        try {
          const { webhookId } = JSON.parse(op.payload_json) as CallWebhookPayload
          this.q.touchWebhookError(webhookId, error)
          this.q.insertRuleLog({
            kind: 'webhook', refId: webhookId, accountId: op.account_id || null, messageId: null,
            summary: tProcess('sync.webhook.failed'), ok: false, error
          })
          this.ev.emitAutomationLogged()
        } catch {
          /* payload bozuksa sessizce geç */
        }
      }
      // gönderim kalıcı olarak başarısızsa taslağı arayüze geri ver. Ekler satır silinene dek diskte kalır: yeniden deneme
      // onlarla gider, iptal ve 30 günlük budama siler
      let draft: DraftOut | undefined
      let senderId: number | undefined
      if (op.kind === 'smtp_send') {
        try {
          const p = JSON.parse(op.payload_json) as SmtpSendPayload
          senderId = p.senderId ?? p.smime?.userId
          // şifreli taslak olaya hiç girmez: gönderen getOpDraft ile alır
          // ana parça gitti: taslak "gönderilmedi" diye dönerse yeniden gönderim To/Cc'ye ikinci kez ulaşır
          if (!p.smime?.encrypt && !partial) draft = p.draft
        } catch {
          /* payload bozuksa taslak kurtarılamaz */
        }
      }
      this.ev.emitOpFailed(op.account_id, op.kind, error, draft, op.id, partial, senderId)
      // kalıcı hata: yerel iyimser durum sunucudan sapmış olabilir → poll uzlaştırır.
      // ileti sunucuda yerinde: gizli kalırsa bir daha görünmez
      if (OPTIMISTIC_HIDE_OPS.has(op.kind)) {
        try {
          const p = JSON.parse(op.payload_json) as TrashPayload
          this.q.unhideByFolderUids(op.account_id, p.folderPath, p.uids)
        } catch {
          /* payload bozuksa satır sıradaki tam senkronda düzelir */
        }
      }
      // trash başarısızlığında klasörü sıfırla ki yeniden çekilsin
      if (op.kind === 'trash') {
        try {
          const p = JSON.parse(op.payload_json) as TrashPayload
          const folders = this.q.getFolders(op.account_id)
          const f = folders.find((x) => x.path === p.folderPath)
          if (f) this.q.resetFolder(f.id)
        } catch {
          /* uzlaştırma en kötü ihtimalle sıradaki tam senkronda olur */
        }
      }
      this.scheduler.pollSoon(op.account_id, 1000)
      this.ev.emitChanged(op.account_id)
    } else {
      // Retry-After header'ı varsa onu kullan (örn. Slack 429), yoksa mevcut üstel eğri
      const backoff = retryAfterMs ?? Math.min(60_000 * 2 ** op.attempts, 30 * 60_000)
      this.q.opRetry(op.id, error, Date.now() + backoff)
    }
  }
}

// nodemailer hata kodları → governor sınıfları. Aşama (smtpSendRaw 'phase') belirleyicidir:
// bağlanırken ağ hatası = login öncesi (IP engeli imzası); gönderirken ağ hatası = belirsiz sonuç.
export function smtpErrorKind(e: unknown): ReturnType<typeof classifyError> | 'uncertain' {
  const err = e as { code?: string; command?: string; responseCode?: number; phase?: 'connect' | 'auth' | 'send' }
  const network = !!err?.code && ['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'ECONNRESET', 'ECONNREFUSED'].includes(err.code) && !err.responseCode
  if (err?.code === 'EAUTH' || err?.responseCode === 535) return 'auth'
  if (err?.responseCode === 421) return 'limit' // 450/451 genelde greylisting: sunucu limiti değil
  if (err?.phase === 'send') return network ? 'uncertain' : 'other' // sunucu kodlu ret kesindir
  if (err?.phase === 'connect') return network ? 'preauth' : classifyError(e)
  if (err?.phase === 'auth') return network ? 'net' : classifyError(e)
  if (network) return !err.command || err.command === 'CONN' || err.command === 'GREETING' ? 'preauth' : 'net'
  return classifyError(e)
}
