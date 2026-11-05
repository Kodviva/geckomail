import { createHash, generateKeyPairSync, sign, type KeyObject } from 'crypto'
import { describe, expect, it, vi } from 'vitest'
import { helloAvailable, HelloGate, verifyAssertion, type HelloCredential, type PageResult } from '../helloGate'
import { renderHelloPage, type HelloPageConfig } from '../hello/page'

const ORIGIN = 'http://localhost:4100'
const b64u = (b: Buffer): string => b.toString('base64url')

function makeKey(kind: 'ec' | 'rsa'): { cred: HelloCredential; priv: KeyObject } {
  const pair = kind === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' }) : generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    cred: { credentialId: 'kimlik', publicKeySpki: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), alg: kind === 'ec' ? -7 : -257 },
    priv: pair.privateKey
  }
}

function assertion(priv: KeyObject, challenge: Buffer, o: { origin?: string; flags?: number; rpId?: string; type?: string } = {}) {
  const authenticatorData = Buffer.concat([
    createHash('sha256').update(o.rpId ?? 'localhost').digest(),
    Buffer.from([o.flags ?? 0x05]),
    Buffer.alloc(4)
  ])
  const clientDataJSON = Buffer.from(JSON.stringify({ type: o.type ?? 'webauthn.get', challenge: b64u(challenge), origin: o.origin ?? ORIGIN, crossOrigin: false }))
  const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), priv)
  return { authenticatorData, clientDataJSON, signature }
}

describe('verifyAssertion', () => {
  const challenge = Buffer.from('rastgele-meydan-okuma-32-bayt!!!')
  const check = (cred: HelloCredential, a: ReturnType<typeof assertion>, c = challenge) =>
    verifyAssertion({ cred, challenge: c, origin: ORIGIN, rpId: 'localhost', ...a })

  it('ES256 ve RS256 kabul', () => {
    for (const kind of ['ec', 'rsa'] as const) {
      const { cred, priv } = makeKey(kind)
      expect(check(cred, assertion(priv, challenge))).toBe(true)
    }
  })
  it('wrong challenge', () => {
    const { cred, priv } = makeKey('ec')
    expect(check(cred, assertion(priv, challenge), Buffer.from('baska'))).toBe(false)
  })
  it('wrong origin', () => {
    const { cred, priv } = makeKey('ec')
    expect(check(cred, assertion(priv, challenge, { origin: 'http://localhost:9' }))).toBe(false)
  })
  it('wrong rp ve tür', () => {
    const { cred, priv } = makeKey('ec')
    expect(check(cred, assertion(priv, challenge, { rpId: 'example.test' }))).toBe(false)
    expect(check(cred, assertion(priv, challenge, { type: 'webauthn.create' }))).toBe(false)
  })
  it('no UV flag', () => {
    const { cred, priv } = makeKey('ec')
    expect(check(cred, assertion(priv, challenge, { flags: 0x01 }))).toBe(false)
    expect(check(cred, assertion(priv, challenge, { flags: 0x04 }))).toBe(false)
  })
  it('tampered data', () => {
    const { cred, priv } = makeKey('ec')
    const a = assertion(priv, challenge)
    a.authenticatorData[33] ^= 1
    expect(check(cred, a)).toBe(false)
    const b = assertion(priv, challenge)
    b.signature[10] ^= 1
    expect(check(cred, b)).toBe(false)
  })
  it('other key', () => {
    expect(check(makeKey('ec').cred, assertion(makeKey('ec').priv, challenge))).toBe(false)
  })
  it('algoritma ve anahtar türü uyuşmazsa ya da girdi bozuksa red', () => {
    const { cred, priv } = makeKey('ec')
    expect(check({ ...cred, alg: -257 }, assertion(priv, challenge))).toBe(false)
    expect(check({ ...cred, publicKeySpki: 'bozuk' }, assertion(priv, challenge))).toBe(false)
    expect(check(cred, { ...assertion(priv, challenge), clientDataJSON: Buffer.from('{') })).toBe(false)
    expect(check(cred, { ...assertion(priv, challenge), authenticatorData: Buffer.alloc(3) })).toBe(false)
  })
})

describe('helloAvailable', () => {
  it('yalnız win32 ve yoklama doğruysa', async () => {
    expect(await helloAvailable('win32', async () => true)).toBe(true)
    expect(await helloAvailable('win32', async () => false)).toBe(false)
    expect(await helloAvailable('win32', () => Promise.reject(new Error('x')))).toBe(false)
    const probe = vi.fn(async () => true)
    expect(await helloAvailable('darwin', probe)).toBe(false)
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('renderHelloPage', () => {
  it('saldırgan neden metni betikten çıkamaz', () => {
    const html = renderHelloPage({ mode: 'verify', challenge: 'YQ', credentialId: 'YQ', rpName: 'GeckoMail', dir: 'ltr', text: { reason: '</script><img src=x>', note: '', failed: '', reenroll: '', cancel: '' } }).toString()
    expect(html).not.toContain('</script><img')
    expect(html).toContain("default-src 'none'")
  })
})

function harness(start: HelloCredential | null) {
  const key = makeKey('ec')
  let stored = start ? { ...start, publicKeySpki: key.cred.publicKeySpki } : null
  const store = { read: vi.fn(() => stored), write: vi.fn((c: HelloCredential | null) => void (stored = c)) }
  const pages: HelloPageConfig[] = []
  const closes: ReturnType<typeof vi.fn>[] = []
  const listen = vi.fn(async (page: Buffer) => {
    pages.push(JSON.parse(/\)\((\{.*\})\)<\/script>/.exec(page.toString())![1]) as HelloPageConfig)
    const close = vi.fn()
    closes.push(close)
    return { url: `${ORIGIN}/yol`, close }
  })
  const enrolled = (): PageResult => ({ kind: 'enrolled', credentialId: 'yeni', publicKeySpki: key.cred.publicKeySpki, alg: -7 })
  const asserted = (): PageResult => {
    const a = assertion(key.priv, Buffer.from(pages[pages.length - 1].challenge, 'base64url'))
    return { kind: 'assertion', authenticatorData: b64u(a.authenticatorData), clientDataJSON: b64u(a.clientDataJSON), signature: b64u(a.signature) }
  }
  const script: (() => PageResult)[] = []
  const showPage = vi.fn(async () => script.shift()!())
  const gate = new HelloGate({ store, showPage, listen, text: () => ({ note: 'not', failed: 'f', reenroll: 'r', cancel: 'c' }), dir: () => 'ltr' })
  return { gate, store, pages, closes, listen, showPage, script, enrolled, asserted, stored: () => stored }
}

describe('HelloGate', () => {
  const known: HelloCredential = { credentialId: 'var', publicKeySpki: '', alg: -7 }

  it('enrolls once', async () => {
    const h = harness(null)
    h.script.push(h.enrolled, h.asserted)
    expect(await h.gate.prompt('neden')).toBe(true)
    expect(h.pages.map((p) => p.mode)).toEqual(['enroll', 'verify'])
    expect(h.pages[1].credentialId).toBe('yeni')
    expect(h.pages[0].text.reason).toBe('neden')
    expect(h.stored()?.credentialId).toBe('yeni')
    h.script.push(h.asserted)
    expect(await h.gate.prompt('neden')).toBe(true)
    expect(h.pages.map((p) => p.mode)).toEqual(['enroll', 'verify', 'verify'])
  })
  it('her istemde yeni meydan okuma', async () => {
    const h = harness(known)
    h.script.push(h.asserted, h.asserted)
    await h.gate.prompt('a')
    await h.gate.prompt('a')
    expect(h.pages[0].challenge).not.toBe(h.pages[1].challenge)
    expect(Buffer.from(h.pages[0].challenge, 'base64url').length).toBe(32)
  })
  it('cancel returns false', async () => {
    const h = harness(known)
    h.script.push(() => ({ kind: 'cancel' }))
    expect(await h.gate.prompt('neden')).toBe(false)
    expect(h.stored()?.credentialId).toBe('var')
  })
  it('kayıt iptal edilirse kimlik yazılmaz', async () => {
    const h = harness(null)
    h.script.push(() => ({ kind: 'cancel' }))
    expect(await h.gate.prompt('neden')).toBe(false)
    expect(h.store.write).not.toHaveBeenCalled()
  })
  it('imzası tutmayan sonuç reddedilir', async () => {
    const h = harness(known)
    h.script.push(() => {
      const r = h.asserted() as Extract<PageResult, { kind: 'assertion' }>
      return { ...r, signature: b64u(Buffer.from('sahte')) }
    })
    expect(await h.gate.prompt('neden')).toBe(false)
  })
  it('server closed after prompt', async () => {
    const h = harness(null)
    h.script.push(h.enrolled, h.asserted)
    await h.gate.prompt('neden')
    expect(h.closes).toHaveLength(2)
    for (const c of h.closes) expect(c).toHaveBeenCalledTimes(1)
    const f = harness(known)
    f.showPage.mockRejectedValueOnce(new Error('pencere'))
    expect(await f.gate.prompt('neden')).toBe(false)
    expect(f.closes[0]).toHaveBeenCalledTimes(1)
  })
  it('credential removed by OS re-enrolls', async () => {
    const h = harness(known)
    h.script.push(() => ({ kind: 'missing' }), h.enrolled, h.asserted)
    expect(await h.gate.prompt('neden')).toBe(true)
    expect(h.pages.map((p) => p.mode)).toEqual(['verify', 'enroll', 'verify'])
    expect(h.stored()?.credentialId).toBe('yeni')
  })
  it('aynı anda ikinci istem açılmaz', async () => {
    const h = harness(known)
    h.script.push(h.asserted)
    const first = h.gate.prompt('a')
    expect(await h.gate.prompt('b')).toBe(false)
    expect(await first).toBe(true)
  })
  it('reset kimliği siler', () => {
    const h = harness(known)
    h.gate.reset()
    expect(h.stored()).toBeNull()
  })
})
