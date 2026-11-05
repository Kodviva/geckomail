// Passkey (WebAuthn) kaydı ve girişi (sunucu modu). Keşfedilebilir kimlik: giriş kullanıcı adı istemez, kullanıcıyı
// kimlik bilgisinin kimliği belirler; kullanıcı doğrulaması zorunlu olduğundan parola + TOTP yerine geçer.
// Challenge'lar bellekte, 5 dk, tek kullanımlık: kayıtta web oturumuna, girişte gm_pk çerezindeki akış kimliğine
// bağlı (yeniden başlatmada düşer, kullanıcı yeniden dener). RP ID ve köken GECKO_PUBLIC_ORIGIN'den.
import { createHash, randomBytes } from 'crypto'
import { isIP } from 'net'
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransport, type RegistrationResponseJSON
} from '@simplewebauthn/server'
import type { SessionUser } from '../shared/rpc'
import type { Queries } from '../sync/db/queries'
import type { PasskeyRow } from '../sync/db/q/webAuth'
import type { LoginResult, WebAuth } from './auth'

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60_000
const NAME_MAX = 64
/** Girişsiz uç bellek büyütemesin: sınırda en eski bekleyen akış düşer */
const FLOWS_MAX = 5000
/** EdDSA, ES256, RS256. Çalışma ortamına göre değişen varsayılan listeye bırakılmaz */
const ALGORITHMS = [-8, -7, -257]

export interface PasskeyInfo {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
}

type RegisterResult =
  | { ok: true; passkey: PasskeyInfo }
  | { ok: false; reason: 'invalid' | 'challenge' | 'bad' | 'duplicate' | 'revoked' }

interface Pending {
  challenge: string
  expiresAt: number
}

/** WebAuthn kullanıcı kimliği: kullanıcı başına sabit, aynı doğrulayıcıda ikinci hesap kaydı oluşmaz */
const userHandleBytes = (userId: number): Uint8Array<ArrayBuffer> => new TextEncoder().encode(String(userId))

const info = (r: PasskeyRow): PasskeyInfo => ({ id: r.id, name: r.name, createdAt: r.created_at, lastUsedAt: r.last_used_at })
/** Günlükte kimlik bilgisi kimliğinin yalnız kısa özeti */
const shortHash = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 12)

/** WebAuthn RP ID alan adı olmalı: kök IP ise passkey çalışmaz (istemci location'dan aynı sonuca varır) */
export const passkeysAvailable = (origin: string): boolean => !isIP(new URL(origin).hostname.replace(/^\[|\]$/g, ''))

export function createPasskeys(o: { q: Queries; auth: WebAuth; publicOrigin: string; now?: () => number }) {
  const { q, auth, publicOrigin: origin } = o
  const now = o.now ?? Date.now
  const rpID = new URL(origin).hostname
  // süreleri aynı: Map ekleme sırası aynı zamanda bitiş sırası
  const registering = new Map<string, Pending>()
  const logins = new Map<string, Pending>()

  const sweep = (m: Map<string, Pending>): void => {
    const n = now()
    for (const [k, p] of m) {
      if (p.expiresAt > n) break
      m.delete(k)
    }
  }
  const put = (m: Map<string, Pending>, key: string, challenge: string): void => {
    sweep(m)
    m.delete(key) // yeni deneme eskisinin yerine; sıra korunsun
    m.set(key, { challenge, expiresAt: now() + PASSKEY_CHALLENGE_TTL_MS })
    if (m.size > FLOWS_MAX) m.delete(m.keys().next().value!)
  }
  /** Tek kullanım: sonuç ne olursa olsun silinir */
  const take = (m: Map<string, Pending>, key: string): string | null => {
    const p = m.get(key)
    m.delete(key)
    return p && p.expiresAt > now() ? p.challenge : null
  }
  /** Saklanan transports yalnız ipucu: bozuksa yok sayılır */
  const transportsOf = (r: PasskeyRow): AuthenticatorTransport[] | undefined => {
    try {
      return r.transports ? (JSON.parse(r.transports) as AuthenticatorTransport[]) : undefined
    } catch {
      return undefined
    }
  }

  return {
    list: (userId: number): PasskeyInfo[] => q.listPasskeys(userId).map(info),

    remove: (userId: number, encodedId: string): boolean => {
      let id: string
      try {
        id = decodeURIComponent(encodedId)
      } catch {
        return false
      }
      return q.deletePasskey(userId, id)
    },

    async registerOptions(user: SessionUser, sessionId: string) {
      const options = await generateRegistrationOptions({
        rpName: 'GeckoMail', rpID, userName: user.username,
        userID: userHandleBytes(user.id),
        attestationType: 'none', supportedAlgorithmIDs: ALGORITHMS,
        excludeCredentials: q.listPasskeys(user.id).map((r) => ({ id: r.id, transports: transportsOf(r) })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
      })
      put(registering, sessionId, options.challenge)
      return options
    },

    async registerVerify(i: { user: SessionUser; sessionId: string; response: Record<string, unknown>; name: string }): Promise<RegisterResult> {
      const name = i.name.trim().slice(0, NAME_MAX).trim()
      if (!name) return { ok: false, reason: 'invalid' }
      const expectedChallenge = take(registering, i.sessionId)
      if (!expectedChallenge) return { ok: false, reason: 'challenge' }
      let credential
      try {
        const v = await verifyRegistrationResponse({
          response: i.response as unknown as RegistrationResponseJSON, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
          requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS
        })
        if (!v.verified) return { ok: false, reason: 'bad' }
        credential = v.registrationInfo.credential
      } catch {
        // kütüphane iletisi istek içeriğini taşır: günlüğe ve yanıta gitmez
        return { ok: false, reason: 'bad' }
      }
      // await sırasında oturum iptal edilmiş ya da kullanıcı devre dışı kalmış olabilir
      if (!q.getWebSession(i.sessionId) || !q.getUserById(i.user.id)?.enabled) return { ok: false, reason: 'revoked' }
      const ok = q.insertPasskey({
        id: credential.id, userId: i.user.id, publicKey: Buffer.from(credential.publicKey), counter: credential.counter,
        transports: credential.transports?.length ? JSON.stringify(credential.transports) : null, name, now: now()
      })
      if (!ok) return { ok: false, reason: 'duplicate' }
      return { ok: true, passkey: info(q.getPasskey(credential.id)!) }
    },

    async loginOptions(ip: string): Promise<{ ok: true; flowId: string; options: object } | { ok: false; reason: 'locked' }> {
      if (auth.passkeyLocked(ip)) return { ok: false, reason: 'locked' }
      const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' })
      const flowId = randomBytes(24).toString('base64url')
      put(logins, flowId, options.challenge)
      return { ok: true, flowId, options }
    },

    /** Gövdesi bozuk istek de akışı bitirir */
    abandonLogin(flowId: string): void {
      logins.delete(flowId)
    },

    async loginVerify(i: { flowId: string; response: Record<string, unknown>; ip: string; userAgent: string }): Promise<LoginResult> {
      const expectedChallenge = take(logins, i.flowId)
      if (auth.passkeyLocked(i.ip)) return { ok: false, reason: 'locked' }
      // süresi dolmuş/kullanılmış akış: doğrulama yapılmadı, kilide sayılmaz (kullanıcı istemi bekletmiş olabilir)
      if (!expectedChallenge) return { ok: false, reason: 'bad' }
      const fail = (): LoginResult => {
        auth.passkeyFailed(i.ip)
        return { ok: false, reason: 'bad' }
      }
      const id = typeof i.response.id === 'string' ? i.response.id : ''
      const row = id ? q.getPasskey(id) : undefined
      if (!row) return fail()
      let counter: number
      try {
        const v = await verifyAuthenticationResponse({
          response: i.response as unknown as AuthenticationResponseJSON, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
          requireUserVerification: true,
          // sayaç aşağıda, imza doğrulandıktan sonra ve güncel satırla denetlenir: kütüphaneninki imzadan önce çalışır
          credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: 0, transports: transportsOf(row) }
        })
        if (!v.verified) return fail()
        counter = v.authenticationInfo.newCounter
        // kullanıcı önceden bilinmiyordu: yanıttaki kullanıcı anahtarın sahibi olmalı (WebAuthn §7.2). userHandle imza
        // kapsamında değil, yalnız tutarlılık denetimi; kimliği imzayla doğrulanan anahtar belirler
        const handle = (i.response.response as { userHandle?: unknown }).userHandle
        if (handle !== Buffer.from(userHandleBytes(row.user_id)).toString('base64url')) return fail()
      } catch {
        return fail()
      }
      // await sırasında eşzamanlı istekler hata yazmış ya da anahtar silinmiş olabilir; buradan sonuca dek await yok
      if (auth.passkeyLocked(i.ip)) return { ok: false, reason: 'locked' }
      const cur = q.getPasskey(id)
      if (!cur) return fail()
      if ((counter > 0 || cur.counter > 0) && counter <= cur.counter) {
        console.error(`gecko: passkey sayacı geriye gitti, giriş reddedildi (anahtar ${shortHash(id)})`)
        return fail()
      }
      if (!q.getUserById(cur.user_id)?.enabled) return fail()
      if (!q.claimPasskeyUse(id, cur.counter, counter, now())) return fail()
      return auth.passkeyLogin(cur.user_id, i.ip, i.userAgent)
    }
  }
}
