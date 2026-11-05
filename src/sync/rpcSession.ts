import type { RpcEventName, RpcEvents, RpcRequest, SessionUser } from '../shared/rpc'
import type { UserRow } from './db/queries'
import { describeError } from './imapClient'
import { t } from '../shared/i18n'
import type { RpcPort } from './rpc/transport'
import { sessionUserFromRow, userCanManage, userCanView } from './auth/sessionUser'
import type { RpcHub, RpcServerDeps, SessionInit } from './rpcHub'
import type { Locale } from '../shared/i18n'
import { runWithLocale } from './sessionLocale'

/** Tek bağlantının oturumu: kimlik, giriş kilidi, geri alma durumu. Handler'ların gördüğü yüzey;
 *  paylaşılan iş (deps, yayın, kasa, senkron) hub'a yönlenir. */
export class RpcSession {
  currentUser: SessionUser | null
  webSessionId: string | null
  ip: string | null
  /** Mobil biletli soket: yönetici, 2FA ve parola yöntemleri kapalı (RpcHub.invoke) */
  readonly ticket: boolean
  /** Sunucu modunda istemcinin arayüz dili (setSessionLocale); null = süreç dili, masaüstünde hep null */
  locale: Locale | null = null
  undoSeq = 0
  undoState = new Map<number, { messageIds: number[]; opId: number }[]>()
  /** taşıma: kaynak klasör başına op; op iptal edilebildiyse yalnız o grubun iletileri geri gelir */
  moveUndo = new Map<number, { accountId: number; opId: number; messageIds: number[] }[]>()
  private closed = false

  constructor(
    readonly hub: RpcHub,
    private readonly port: RpcPort,
    init: SessionInit,
    private readonly onGone: () => void
  ) {
    this.currentUser = init.user ?? null
    this.webSessionId = init.webSessionId ?? null
    this.ip = init.ip ?? null
    this.ticket = init.ticket ?? false
    port.onMessage((msg) => {
      const req = msg as RpcRequest
      if (!req || typeof req.id !== 'number' || !req.method) return
      void this.dispatch(req)
    })
    // karşı uç koptu: oturum hub'dan düşer
    port.onClose(() => {
      this.closed = true
      this.onGone()
    })
  }

  get deps(): RpcServerDeps {
    return this.hub.deps
  }

  get bodyInflight(): Map<number, 'fetching' | string> {
    return this.hub.bodyInflight
  }

  // giriş kilidi hub'da tutulur (oturum başına değil): yeniden bağlanarak beklemeyi atlatmak olmaz
  get loginFailures(): number {
    return this.hub.loginFailures
  }

  set loginFailures(n: number) {
    this.hub.loginFailures = n
  }

  get loginLockedUntil(): number {
    return this.hub.loginLockedUntil
  }

  set loginLockedUntil(ms: number) {
    this.hub.loginLockedUntil = ms
  }

  send(msg: unknown): void {
    if (this.closed) return
    try {
      this.port.send(msg)
    } catch {
      /* port ölmüş olabilir; kapanış olayı oturumu düşürür */
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.port.close()
    } catch {
      /* eski port zaten ölü olabilir */
    }
    this.onGone()
  }

  broadcast<E extends RpcEventName>(event: E, data: RpcEvents[E]): void {
    this.hub.broadcast(event, data)
  }

  broadcastDebounced<E extends RpcEventName>(event: E, data: RpcEvents[E], ms?: number): void {
    this.hub.broadcastDebounced(event, data, ms)
  }

  lockVaultNow(): void {
    this.hub.lockVaultNow()
  }

  oneClickUnsubscribe(messageId: number): Promise<{ ok: boolean; error?: string }> {
    return this.hub.oneClickUnsubscribe(messageId)
  }

  doSyncPush(anchorAccountId: number, passphrase: string): ReturnType<RpcHub['doSyncPush']> {
    return this.hub.doSyncPush(anchorAccountId, passphrase)
  }

  doSyncPull(anchorAccountId: number, passphrase: string): ReturnType<RpcHub['doSyncPull']> {
    return this.hub.doSyncPull(anchorAccountId, passphrase)
  }

  buildSessionUser(row: UserRow): SessionUser {
    return sessionUserFromRow(this.deps.q, row)
  }

  /** Yayın süzgeci için: fırlatmadan görme yetkisi (girişsiz oturum hiçbir şeyi görmez) */
  canViewAccount(accountId: number): boolean {
    const u = this.currentUser
    return !!u && userCanView(this.deps.q, u, accountId)
  }

  assertCanView(accountId: number): void {
    if (!userCanView(this.deps.q, this.currentUser!, accountId)) throw new Error(t('sync.perm.cannotView'))
  }

  assertCanManage(accountId: number): void {
    if (!userCanManage(this.deps.q, this.currentUser!, accountId)) throw new Error(t('sync.perm.cannotManage'))
  }

  // admin için `requested`'ı olduğu gibi geçirir (null dahil — sorgu katmanı zaten filtre uygulamıyor).
  // member için ASLA null döndürmez: null "tümü" isteğini görünür hesaplara indirger, boş bir
  // istek de görünür hesaplarla kesişir. Çağıran taraf `ids.length===0` durumunu filtre iptali
  // olarak DEĞİL, "gösterilecek bir şey yok" olarak ele almalı — aksi halde boş dizi mevcut
  // `if (accountIds && accountIds.length)` sorgu koruması tarafından null gibi yorumlanıp
  // yanlışlıkla TÜM hesapları döndürür.
  resolveAccountIds(requested: number[] | null): number[] | null {
    const u = this.currentUser!
    if (u.role === 'admin') return requested
    const visible = this.deps.q.getAccountIdsForGroups(u.permittedGroupIds)
    if (requested == null) return visible
    const visibleSet = new Set(visible)
    return requested.filter((id) => visibleSet.has(id))
  }

  // hata metni (describeError) de oturum dilinde olsun diye bağlam yanıtı da kapsar
  private dispatch(req: RpcRequest): Promise<void> {
    return runWithLocale(this.locale, async () => {
      try {
        const result = await this.handle(req.method, req.params)
        this.send({ id: req.id, ok: true, result })
      } catch (e) {
        this.send({ id: req.id, ok: false, error: describeError(e) })
      }
    })
  }

  /** Yetki kapısı + yöntem çağrısı. Handler'lar da (ör. toplu güncelleme) aynı kapıdan geçer. */
  handle(method: string, params: unknown): Promise<unknown> {
    return this.hub.invoke(this, method, params)
  }
}
