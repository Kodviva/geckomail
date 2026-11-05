// Windows Hello kapısı (yerel mod): `promptBiometric` bir onaydır, sır zaten safeStorage'da. WebAuthn platform
// doğrulayıcısı kullanılır, yerel eklenti gerekmez. Electron'a bağlı parçalar enjekte edilir (helloWindow.ts).
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'crypto'
import { renderHelloPage, type HelloPageConfig } from './hello/page'
import type { Os } from './os'

const RP_ID = 'localhost'

/** `userData/hello.json`; sır değildir, Windows kullanıcısına bağlıdır */
export interface HelloCredential {
  credentialId: string
  /** base64 DER */
  publicKeySpki: string
  alg: -7 | -257
}

export type PageResult =
  | { kind: 'cancel' }
  /** kullanıcı yeniden kaydı seçti: kimlik işletim sisteminde yok */
  | { kind: 'missing' }
  | { kind: 'enrolled'; credentialId: string; publicKeySpki: string; alg: number }
  | { kind: 'assertion'; authenticatorData: string; clientDataJSON: string; signature: string }

export function verifyAssertion(o: {
  cred: HelloCredential
  challenge: Buffer
  origin: string
  rpId: 'localhost'
  authenticatorData: Buffer
  clientDataJSON: Buffer
  signature: Buffer
}): boolean {
  try {
    const client = JSON.parse(o.clientDataJSON.toString('utf8')) as { type?: unknown; challenge?: unknown; origin?: unknown }
    if (client.type !== 'webauthn.get' || client.challenge !== o.challenge.toString('base64url') || client.origin !== o.origin) return false
    const data = o.authenticatorData
    if (data.length < 37) return false
    const rpHash = createHash('sha256').update(o.rpId).digest()
    if (!timingSafeEqual(data.subarray(0, 32), rpHash)) return false
    const UP = 0x01
    const UV = 0x04
    if ((data[32] & (UP | UV)) !== (UP | UV)) return false
    const key = createPublicKey({ key: Buffer.from(o.cred.publicKeySpki, 'base64'), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== (o.cred.alg === -7 ? 'ec' : 'rsa')) return false
    const signed = Buffer.concat([data, createHash('sha256').update(o.clientDataJSON).digest()])
    return verify('sha256', signed, key, o.signature)
  } catch {
    return false
  }
}

export function helloAvailable(os: Os, probe: () => Promise<boolean>): Promise<boolean> {
  return os === 'win32' ? probe().catch(() => false) : Promise.resolve(false)
}

export class HelloGate {
  private busy = false

  constructor(
    private readonly o: {
      store: { read(): HelloCredential | null; write(c: HelloCredential | null): void }
      showPage(url: string): Promise<PageResult>
      listen(page: Buffer): Promise<{ url: string; close(): void }>
      text(): Omit<HelloPageConfig['text'], 'reason'>
      dir(): 'ltr' | 'rtl'
    }
  ) {}

  /** Kayıt yoksa önce kayıt. Yalnız imzası doğrulanan sonuç true döner; her hata false. */
  async prompt(reason: string): Promise<boolean> {
    if (this.busy) return false
    this.busy = true
    try {
      let cred = this.o.store.read()
      // silinen kimlik: bir kez yeniden kayıt, sonra doğrulama; döngü bunun ötesine gitmez
      for (let round = 0; round < 2; round++) {
        cred ??= await this.enroll(reason)
        if (!cred) return false
        const challenge = randomBytes(32)
        const { result, origin } = await this.show('verify', challenge, reason, cred.credentialId)
        if (result.kind === 'assertion') {
          return verifyAssertion({
            cred,
            challenge,
            origin,
            rpId: RP_ID,
            authenticatorData: Buffer.from(result.authenticatorData, 'base64url'),
            clientDataJSON: Buffer.from(result.clientDataJSON, 'base64url'),
            signature: Buffer.from(result.signature, 'base64url')
          })
        }
        if (result.kind !== 'missing') return false
        this.reset()
        cred = null
      }
      return false
    } catch {
      return false
    } finally {
      this.busy = false
    }
  }

  reset(): void {
    this.o.store.write(null)
  }

  private async enroll(reason: string): Promise<HelloCredential | null> {
    const { result } = await this.show('enroll', randomBytes(32), reason)
    if (result.kind !== 'enrolled' || (result.alg !== -7 && result.alg !== -257)) return null
    const cred: HelloCredential = { credentialId: result.credentialId, publicKeySpki: result.publicKeySpki, alg: result.alg }
    this.o.store.write(cred)
    return cred
  }

  private async show(mode: HelloPageConfig['mode'], challenge: Buffer, reason: string, credentialId?: string): Promise<{ result: PageResult; origin: string }> {
    const page = renderHelloPage({
      mode,
      challenge: challenge.toString('base64url'),
      credentialId,
      rpName: 'GeckoMail',
      dir: this.o.dir(),
      text: { ...this.o.text(), reason }
    })
    const server = await this.o.listen(page)
    try {
      return { result: await this.o.showPage(server.url), origin: new URL(server.url).origin }
    } finally {
      server.close()
    }
  }
}
