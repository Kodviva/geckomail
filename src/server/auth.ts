// Sunucu modu web girişi: parola + TOTP, çerezli oturumlar ve giriş kilidi. Kilit bağlantı başına değil
// DB'de (IP ve kullanıcı adı başına): yeniden bağlanmak ya da süreci yeniden başlatmak beklemeyi atlatmaz.
// Belirteç yalnız login yanıtında (web katmanı Set-Cookie ile gönderir); DB'de sha256 özeti tutulur.
import { createHash, randomBytes } from 'crypto'
import type { SessionUser } from '../shared/rpc'
import { hashPassword, verifyPassword } from '../sync/auth/password'
import { sessionUserFromRow } from '../sync/auth/sessionUser'
import type { Queries, SessionKind, UserRow, WebSessionRow } from '../sync/db/queries'
import type { EngineHost } from '../sync/host'
import { base32Decode, base32Encode, newTotpSecret, otpauthUri, verifyTotp } from '../sync/auth/totp'

export const SESSION_TTL_MS = 30 * 24 * 3600_000
export const SESSION_IDLE_MS = 7 * 24 * 3600_000
/** Push teslimi için boşta sınırı: bildirim uygulama kapalıyken gelir, açılmamış olması gönderimi kesmemeli. Posta kutusu
 *  erişimi bundan etkilenmez: SESSION_IDLE_MS aşılınca yeniden giriş gerekir, çalınan çerez sonradan bir şey açamaz. */
export const SESSION_IDLE_PUSH_MS = 30 * 24 * 3600_000
export const LOCK_WINDOW_MS = 15 * 60_000
export const LOCK_MAX_FAILS = 5
const ATTEMPT_KEEP_MS = 24 * 3600_000
/** Passkey denemeleri kullanıcı adı taşımaz: ayrılmış anahtarla yazılır, kilitte yalnız IP sayılır (ortak kova
 *  yok). Büyük harfli: loginKey hep küçük harf üretir, hiçbir kullanıcı adıyla çakışamaz. */
export const PASSKEY_ATTEMPT_KEY = '#PASSKEY'

export type LoginResult =
  | { ok: true; token: string; user: SessionUser }
  | { ok: false; reason: 'bad' | 'locked' | 'totpRequired' | 'totpBad' | 'totpSetupRequired' }

export type { SessionKind }

export interface ResolvedSession { user: SessionUser; sessionId: string; expiresAt: number }

/** Belirteçten oturum kimliği (DB'deki sha256 özeti); WebSocket oturumlarını eşlemek için */
export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')

/** Süresi uzatılan push oturumunda günde en çok bir yazma */
const ROLL_STEP_MS = 24 * 3600_000

/** Oturum posta kutusuna erişebilir mi: süresi ve boşta süresi dolmamış */
export const sessionLive = (s: WebSessionRow, now: number): boolean => now <= s.expires_at && now - s.last_seen_at <= SESSION_IDLE_MS

/** Oturumun cihazına push gidebilir mi: erişim bitmiş olsa da uzun boşta sınırı içinde */
export const sessionPushLive = (s: WebSessionRow, now: number): boolean => now <= s.expires_at && now - s.last_seen_at <= SESSION_IDLE_PUSH_MS

/** Giriş kilidi anahtarı: kırpılmış, küçük harf (büyük/küçük harf oynayarak sayaç sıfırlanamaz) */
export const loginKey = (username: string): string => username.trim().toLowerCase()

// olmayan kullanıcıda da scrypt çalışsın: yanıt süresinden kullanıcı adının varlığı anlaşılmasın
let dummyHash: string | null = null

/** checkPassword'ün başarılı bağlamı: await sonrası yeniden denetim ve kilit/hata kaydı için */
interface PasswordOk {
  ok: true; q: Queries; row: UserRow; now: number; ip: string; key: string; locked(): boolean
  fail<R extends 'bad' | 'totpBad'>(reason: R): { ok: false; reason: R }
  fresh(): UserRow | undefined
  stillValid(): boolean
}

export class WebAuth {
  constructor(
    private readonly q: Queries,
    private readonly host: EngineHost,
    private readonly now: () => number = Date.now
  ) {}

  async login(i: { username: string; password: string; totp?: string; ip: string; userAgent: string }, kind: SessionKind = 'web'): Promise<LoginResult> {
    const c = this.checkPassword(i)
    if (!c.ok) return c.result
    const { q, row } = c
    if (row.totp_enabled) {
      if (!i.totp) {
        q.recordWebLoginAttempt(c.now, c.ip, c.key, 2)
        return { ok: false, reason: 'totpRequired' }
      }
      const refused = await this.claimTotp(c, i.totp)
      if (refused) return refused
    } else if (q.prefGet('require2fa') === '1') {
      q.recordWebLoginAttempt(c.now, c.ip, c.key, 2)
      return { ok: false, reason: 'totpSetupRequired' }
    }
    return this.issueSession(c, i.userAgent, kind)
  }

  /** Zorunlu 2FA kurulumu, oturum yokken (giriş 'totpSetupRequired' döndüğünde): parola yeniden
   *  doğrulanır (kilit geçerli, hatalar sayılır). Yalnız 2FA zorunluyken ve etkin TOTP yokken; bekleyen
   *  sır şifreli yazılır (totp_enabled = 0). Sır yalnız bu yanıtta döner. */
  async setupBegin(i: { username: string; password: string; ip: string }): Promise<
    { ok: true; otpauthUri: string; secretBase32: string } | { ok: false; reason: 'bad' | 'locked' | 'notRequired' }
  > {
    const c = this.checkPassword(i)
    if (!c.ok) return c.result
    const { q, row } = c
    const notRequired = (): boolean => !!c.fresh()?.totp_enabled || q.prefGet('require2fa') !== '1'
    if (notRequired()) {
      q.recordWebLoginAttempt(c.now, c.ip, c.key, 2)
      return { ok: false, reason: 'notRequired' }
    }
    const secret = newTotpSecret()
    const secretBase32 = base32Encode(secret)
    const [enc] = await this.host.encrypt([secretBase32])
    if (!c.stillValid()) return c.fail('bad')
    // await sırasında başka yoldan etkinleşmiş olabilir: etkin sır kodsuz ezilmez (setTotpPending 2FA'yı kapatırdı)
    if (notRequired()) return { ok: false, reason: 'notRequired' }
    q.setTotpPending(row.id, Buffer.from(enc))
    q.recordWebLoginAttempt(c.now, c.ip, c.key, 2)
    return { ok: true, otpauthUri: otpauthUri(secret, row.username), secretBase32 }
  }

  /** Bekleyen sırrı kodla onaylar, 2FA'yı açar ve başarılı giriş gibi yeni belirteçle oturum açar */
  async setupConfirm(i: { username: string; password: string; code: string; ip: string; userAgent: string }): Promise<LoginResult> {
    const c = this.checkPassword(i)
    if (!c.ok) return c.result
    const { q, row } = c
    // etkin 2FA varsa kurulum yolu oturum açmaz: normal giriş (kodla) kullanılmalı
    if (row.totp_enabled) {
      q.recordWebLoginAttempt(c.now, c.ip, c.key, 2)
      return { ok: false, reason: 'totpRequired' }
    }
    const pending = row.totp_secret_enc
    if (!pending || !i.code) return c.fail('totpBad')
    const secret = await this.totpSecret(pending)
    if (!c.stillValid()) return c.fail('bad')
    const cur = c.fresh()!
    if (cur.totp_enabled) return { ok: false, reason: 'totpRequired' }
    // await sırasında yeni bekleyen sır yazılmışsa eski sırra karşı doğrulanan kod kabul edilmez
    if (!cur.totp_secret_enc || !Buffer.from(cur.totp_secret_enc).equals(Buffer.from(pending))) return c.fail('totpBad')
    if (c.locked()) return { ok: false, reason: 'locked' }
    const step = secret ? verifyTotp(secret, String(i.code), Math.floor(c.now / 1000)) : null
    if (step == null || !q.claimTotpStep(row.id, step)) return c.fail('totpBad')
    q.enableTotp(row.id, step)
    return this.issueSession(c, i.userAgent)
  }

  /** Girişli kullanıcının kimliğini yeniden doğrular (passkey ekleme): parola + 2FA açıksa kod. Hatalar girişle aynı
   *  kilide sayılır, kod tek kullanımlıktır. Parola denemesine yanıt vermez: 2FA açık ve kod yoksa parola hiç
   *  denetlenmez; yanlış parola ile yanlış kod aynı 'bad' sonucunu verir. */
  async reauthenticate(i: { userId: number; password: string; totp?: string; ip: string }): Promise<
    { ok: true } | { ok: false; reason: 'bad' | 'locked' | 'totpRequired' }
  > {
    const user = this.q.getUserById(i.userId)
    if (!user) return { ok: false, reason: 'bad' }
    if (user.totp_enabled && !i.totp) return { ok: false, reason: 'totpRequired' }
    const c = this.checkPassword({ username: user.username, password: i.password, ip: i.ip })
    if (!c.ok) return c.result
    if (c.row.id !== i.userId) return c.fail('bad')
    if (c.row.totp_enabled) {
      // bu arada 2FA açıldı: kod gelmediyse yeniden istenir
      if (!i.totp) return { ok: false, reason: 'totpRequired' }
      const refused = await this.claimTotp(c, i.totp)
      if (refused) return { ok: false, reason: refused.reason === 'locked' ? 'locked' : 'bad' }
    }
    c.q.recordWebLoginAttempt(c.now, c.ip, c.key, 2)
    return { ok: true }
  }

  /** Kodu doğrular ve adımını sahiplenir; null: kabul. Parola adımı geçtikten sonra (checkPassword bağlamıyla). */
  private async claimTotp(c: PasswordOk, code: string): Promise<{ ok: false; reason: 'bad' | 'locked' | 'totpBad' } | null> {
    const { q, row } = c
    const enc = row.totp_secret_enc
    const secret = await this.totpSecret(enc)
    // await sırasında kullanıcı devre dışı bırakılmış/silinmiş ya da parolası değişmiş olabilir
    if (!c.stillValid()) return c.fail('bad')
    // ya da yönetici 2FA'yı sıfırlamış/sır değişmiş: eski sırra karşı doğrulanan kod kabul edilmez
    const cur = c.fresh()!
    if (!cur.totp_enabled || !enc || !cur.totp_secret_enc || !Buffer.from(cur.totp_secret_enc).equals(Buffer.from(enc))) return c.fail('totpBad')
    // await sırasında eşzamanlı istekler hata yazmış olabilir: kilit yeniden, eşzamanlı olarak denetlenir
    // (buradan sonuç kaydına kadar await yok — 5 hata sınırı aşılamaz)
    if (c.locked()) return { ok: false, reason: 'locked' }
    const step = secret ? verifyTotp(secret, code, Math.floor(c.now / 1000)) : null
    // aynı (ya da daha eski) adımın kodu ikinci kez kabul edilmez; sahiplenme tek SQL ile atomik
    if (step == null || !q.claimTotpStep(row.id, step)) return c.fail('totpBad')
    return null
  }

  /** Ortak ilk adım: IP, kilit ve parola. Başarısızlık kaydedilir. Dönen bağlam await sonrası
   *  yeniden denetim (kullanıcı hâlâ etkin, parolası aynı) ve kilit/hata kaydı için. */
  private checkPassword(i: { username: string; password: string; ip: string }):
    | { ok: false; result: { ok: false; reason: 'bad' | 'locked' } }
    | PasswordOk {
    const q = this.q
    const now = this.now()
    const username = String(i.username ?? '').trim()
    const key = loginKey(username)
    const ip = String(i.ip ?? '').trim()
    // IP'siz istek ortak bir kilit kovası oluşturmasın: web katmanı her zaman IP verir, vermezse reddedilir
    if (!ip) return { ok: false, result: { ok: false, reason: 'bad' } }
    q.pruneWebLoginAttempts(now - ATTEMPT_KEEP_MS)

    const locked = (): boolean => {
      const f = q.webLoginFailuresSince(now - LOCK_WINDOW_MS, ip, key)
      if (f.byIp < LOCK_MAX_FAILS && f.byUser < LOCK_MAX_FAILS) return false
      // kilitliyken parola denetlenmez (tahmin denemesi bilgi vermez); kayıt kilidi uzatmaz
      q.recordWebLoginAttempt(now, ip, key, 2)
      return true
    }
    if (locked()) return { ok: false, result: { ok: false, reason: 'locked' } }
    const fail = <R extends 'bad' | 'totpBad'>(reason: R): { ok: false; reason: R } => {
      q.recordWebLoginAttempt(now, ip, key, 0)
      return { ok: false, reason }
    }

    const row = username ? q.getUserByUsername(username) : undefined
    const password = String(i.password ?? '')
    if (!row) {
      verifyPassword(password, (dummyHash ??= hashPassword(randomBytes(16).toString('hex'))))
      return { ok: false, result: fail('bad') }
    }
    if (!verifyPassword(password, row.password_hash) || !row.enabled) return { ok: false, result: fail('bad') }
    const fresh = (): UserRow | undefined => q.getUserById(row.id)
    const stillValid = (): boolean => {
      const r = fresh()
      return !!r && !!r.enabled && r.password_hash === row.password_hash
    }
    return { ok: true, q, row, now, ip, key, locked, fail, fresh, stillValid }
  }

  private issueSession(c: { q: Queries; row: UserRow; now: number; ip: string; key: string }, userAgent: string, kind: SessionKind = 'web'): LoginResult {
    const { q, row, now, ip } = c
    q.recordWebLoginAttempt(now, ip, c.key, 1)
    // her başarılı girişte yeni belirteç: oturum sabitleme yok
    const token = randomBytes(32).toString('base64url')
    q.insertWebSession({
      idHash: tokenHash(token), userId: row.id, now, expiresAt: now + SESSION_TTL_MS, ip, userAgent: userAgent || null, kind
    })
    q.touchLastLogin(row.id)
    // güncel satırdan (rol/izinler await sırasında değişmiş olabilir)
    return { ok: true, token, user: sessionUserFromRow(q, q.getUserById(row.id) ?? row) }
  }

  /** Bu IP'den passkey denenebilir mi. Kullanıcı adının parola kilidi burada sayılmaz: kilit başkasının parola
   *  denemeleriyle düşürülebilir; anahtarın sahibi girebilmeli. IP'siz istek ortak kova yaratmasın diye kilitli sayılır. */
  passkeyLocked(ip: string): boolean {
    const q = this.q
    const now = this.now()
    if (!ip) return true
    q.pruneWebLoginAttempts(now - ATTEMPT_KEEP_MS)
    if (q.webLoginFailuresSince(now - LOCK_WINDOW_MS, ip, PASSKEY_ATTEMPT_KEY).byIp < LOCK_MAX_FAILS) return false
    q.recordWebLoginAttempt(now, ip, PASSKEY_ATTEMPT_KEY, 2)
    return true
  }

  passkeyFailed(ip: string): void {
    this.q.recordWebLoginAttempt(this.now(), ip, PASSKEY_ATTEMPT_KEY, 0)
  }

  /** Passkey doğrulandı (kullanıcı doğrulamalı, parola + TOTP yerine geçer; zorunlu 2FA'yı da karşılar).
   *  Çağıran doğrulamadan sonra eşzamanlı olarak çağırır; kullanıcı devre dışı/silinmişse oturum açılmaz. */
  passkeyLogin(userId: number, ip: string, userAgent: string): LoginResult {
    const q = this.q
    const row = q.getUserById(userId)
    if (!row || !row.enabled) {
      this.passkeyFailed(ip)
      return { ok: false, reason: 'bad' }
    }
    return this.issueSession({ q, row, now: this.now(), ip, key: loginKey(row.username) }, userAgent)
  }

  /** Süresi ya da boşta süresi dolmuşsa veya kullanıcı devre dışıysa null (satır silinir); geçerliyse last_seen_at yenilenir.
   *  Boşta kalan ama push cihazı olan oturum erişim vermez, satırı da durur: cihazına bildirim sürer, reddedilen istek
   *  boşta süresini sıfırlamaz. Kullanılan push oturumunun süresi uzar: her gün açan kişide bildirim kesilmez.
   *  Tür uymazsa null, satır silinmez: mobil belirteç çerez olarak geçmez, çerez belirteci mobil uçlarda geçmez. */
  resolve(token: string, kind: SessionKind = 'web'): ResolvedSession | null {
    if (typeof token !== 'string' || !token) return null
    return this.resolveId(tokenHash(token), kind)
  }

  /** Mobil oturum boşta kaldı ama cihazına push sürüyor: erişim yok, satır duruyor. resolve null döndükten sonra iptalden ayırır */
  mobileIdle(token: string): boolean {
    const id = tokenHash(token)
    const s = this.q.getWebSession(id)
    if (!s || s.kind !== 'mobile') return false
    const now = this.now()
    return !sessionLive(s, now) && sessionPushLive(s, now) && Boolean(this.q.getUserById(s.user_id)?.enabled) && this.q.webSessionHasPush(id)
  }

  /** Erişim belirteci ve WS bileti yolu: oturum kimliğiyle, resolve ile aynı boşta ve uzatma kuralı */
  resolveSession(sessionId: string): ResolvedSession | null {
    return this.resolveId(sessionId, 'mobile')
  }

  private resolveId(id: string, kind: SessionKind): ResolvedSession | null {
    const q = this.q
    const now = this.now()
    const s = q.getWebSession(id)
    if (!s || s.kind !== kind) return null
    const row = q.getUserById(s.user_id)
    const usable = row?.enabled && sessionLive(s, now)
    if (!usable) {
      if (row?.enabled && sessionPushLive(s, now) && q.webSessionHasPush(id)) return null
      q.deleteWebSession(id)
      q.deletePushDevicesForSession(id)
      return null
    }
    q.touchWebSession(id, now)
    let expiresAt = s.expires_at
    if (now + SESSION_TTL_MS - expiresAt >= ROLL_STEP_MS && q.webSessionHasPush(id)) {
      expiresAt = now + SESSION_TTL_MS
      q.extendWebSession(id, expiresAt)
    }
    return { user: sessionUserFromRow(q, row), sessionId: id, expiresAt }
  }

  /** Boşta kalmış oturumda da çalışır: yerelde bekleyen çıkış süresi geçmiş belirteçle gelebilir. Tür uymazsa false, satır durur. */
  logout(token: string, kind: SessionKind = 'web'): boolean {
    if (typeof token !== 'string' || !token) return false
    const id = tokenHash(token)
    const s = this.q.getWebSession(id)
    if (s && s.kind !== kind) return false
    this.endSession(id)
    return true
  }

  /** Oturumu kimliğiyle bitirir; çağıran açık soketleri kapatır */
  endSession(id: string): void {
    this.q.deleteWebSession(id)
    this.q.deletePushDevicesForSession(id) // çıkış yapan cihaza push gitmez
  }

  /** Süresi dolan oturumları ve cihazlarını siler: geri dönmeyen kullanıcı resolve'a hiç uğramaz, cihazına
   *  push sürerdi. Açık soketleri periyodik yeniden doğrulama kapatır. */
  sweepExpired(): number[] {
    const gone = this.q.deleteExpiredWebSessions(this.now(), SESSION_IDLE_MS, SESSION_IDLE_PUSH_MS)
    for (const { idHash } of gone) this.q.deletePushDevicesForSession(idHash)
    return [...new Set(gone.map((g) => g.userId))]
  }

  /** Kullanıcının web oturumlarını ve push cihazlarını siler (keepIdHash oturumu ve cihazları hariç); silinen oturum kimlikleri
   *  (açık soketleri kapatmak için) */
  revokeUser(userId: number, keepIdHash?: string): string[] {
    this.q.deletePushDevicesForUser(userId, keepIdHash)
    return this.q.deleteWebSessionsForUser(userId, keepIdHash)
  }

  private async totpSecret(enc: Buffer | null): Promise<Buffer | null> {
    if (!enc) return null
    const [plain] = await this.host.decrypt([new Uint8Array(enc)])
    if (!plain?.length) return null // çözülemeyen sır: kod kabul edilmez
    try {
      return base32Decode(Buffer.from(plain).toString('utf-8'))
    } catch {
      return null
    }
  }
}
