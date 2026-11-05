import { execFileSync, spawnSync } from 'node:child_process'
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SMIME_P12_MAX_BYTES } from '../../../shared/smime'
import { SmimeFormatError, SmimeP12PasswordError } from '../errors'
import { buildP12, buildP12Bags, MAX_P12_PASSWORD, parseP12, pkcs12Kdf, pkcs12KdfInWorker } from '../p12'
import { certDer, fxBytes, pemCerts } from './fx'

const PASS = fxBytes('p12-password.txt').toString().trim()
const alice = certDer('alice')
const aliceKey = (): Buffer => createPrivateKey(fxBytes('alice.key')).export({ type: 'pkcs8', format: 'der' })
const bobKey = (): Buffer => createPrivateKey(fxBytes('bob.key')).export({ type: 'pkcs8', format: 'der' })
const hasOpenssl = spawnSync('openssl', ['version']).status === 0
const SHA1_OID = Buffer.from('06052b0e03021a', 'hex')
const DES3_OID = Buffer.from('06082a864886f70d0307', 'hex')
const PBE_3DES_OID = Buffer.from('060a2a864886f70d010c0103', 'hex')
const PBES2_OID = Buffer.from('06092a864886f70d01050d', 'hex')

function expectAlice(c: Awaited<ReturnType<typeof parseP12>>): void {
  expect(Buffer.from(c.leaf).equals(alice)).toBe(true)
  const pub = createPublicKey(createPrivateKey({ key: c.keyPkcs8, format: 'der', type: 'pkcs8' }) as unknown as string)
  expect(pub.equals(new X509Certificate(alice).publicKey)).toBe(true)
  const subjects = c.chain.map((d) => new X509Certificate(d).subject)
  expect(subjects).toHaveLength(2)
}

describe('parseP12', () => {
  it('imports aes256 pbes2 p12', async () => {
    expectAlice(await parseP12(fxBytes('alice-modern.p12'), PASS))
  })

  it('imports legacy rc2-40 + 3des p12', async () => {
    expectAlice(await parseP12(fxBytes('alice-legacy.p12'), PASS))
  })

  it('imports 3des-only windows style p12', async () => {
    expectAlice(await parseP12(fxBytes('alice-3des.p12'), PASS))
  })

  it('imports rc2-128 certificate container', async () => {
    expectAlice(await parseP12(fxBytes('alice-rc2-128.p12'), PASS))
  })

  it('wrong password rejected by mac', async () => {
    await expect(parseP12(fxBytes('alice-modern.p12'), 'yanlis')).rejects.toBeInstanceOf(SmimeP12PasswordError)
    await expect(parseP12(fxBytes('alice-legacy.p12'), 'yanlis')).rejects.toBeInstanceOf(SmimeP12PasswordError)
  })

  it('no private key rejected', async () => {
    await expect(parseP12(await buildP12Bags([], [alice], PASS), PASS)).rejects.toBeInstanceOf(SmimeFormatError)
  })

  it('key/cert mismatch rejected', async () => {
    const p12 = await buildP12({ keyPkcs8: bobKey(), leaf: alice, chain: [] }, PASS)
    await expect(parseP12(p12, PASS)).rejects.toBeInstanceOf(SmimeFormatError)
  })

  it('two private keys rejected', async () => {
    await expect(parseP12(await buildP12Bags([aliceKey(), bobKey()], [alice], PASS), PASS)).rejects.toBeInstanceOf(SmimeFormatError)
  })

  it('oversized or garbage input is a format error', async () => {
    await expect(parseP12(Buffer.alloc(SMIME_P12_MAX_BYTES + 1), PASS)).rejects.toBeInstanceOf(SmimeFormatError)
    await expect(parseP12(Buffer.from('p12 degil'), PASS)).rejects.toBeInstanceOf(SmimeFormatError)
    await expect(parseP12(fxBytes('alice-modern.p12').subarray(0, 900), PASS)).rejects.toBeInstanceOf(SmimeFormatError)
  })

  it('kabuk sayısı çözmeden önce sınırlanır', async () => {
    const p12 = await buildP12Bags([aliceKey()], [alice], PASS, { extraShells: 40 })
    await expect(parseP12(p12, PASS, { maxIterations: 700_000 })).rejects.toBeInstanceOf(SmimeFormatError)
    const t0 = Date.now()
    await expect(parseP12(p12, PASS)).rejects.toBeInstanceOf(SmimeFormatError)
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  it('dosya başına toplam tur bütçesi', async () => {
    const p12 = await buildP12Bags([aliceKey()], [alice], PASS, { extraShells: 2 })
    await expect(parseP12(p12, PASS, { maxIterations: 1_500_000 })).rejects.toBeInstanceOf(SmimeFormatError)
  })

  it('anahtar torbası çözmeden önce sınırlanır', async () => {
    const k = aliceKey()
    await expect(parseP12(await buildP12Bags([k, k, k, k], [alice], PASS), PASS)).rejects.toBeInstanceOf(SmimeFormatError)
  })

  it('parola uzunluğu sınırlıdır', async () => {
    await expect(parseP12(fxBytes('alice-modern.p12'), 'x'.repeat(MAX_P12_PASSWORD + 1))).rejects.toBeInstanceOf(SmimeFormatError)
  })

  it('errors carry no password', async () => {
    const secret = 'cok-gizli-parola-123'
    const e = await parseP12(fxBytes('alice-modern.p12'), secret).catch((x: Error) => x)
    expect(String((e as Error).message) + String((e as Error).stack)).not.toContain(secret)
  })
})

describe('buildP12', () => {
  const parts = { keyPkcs8: aliceKey(), leaf: alice, chain: pemCerts('chain.pem') }

  it('export round trips and is pbes2', async () => {
    const out = await buildP12(parts, 'yeni-parola-1234')
    expect(out.includes(PBES2_OID)).toBe(true)
    expectAlice(await parseP12(out, 'yeni-parola-1234'))
  })

  it('export output has no sha1 or 3des oid', async () => {
    const out = await buildP12(parts, 'yeni-parola-1234')
    for (const oid of [SHA1_OID, DES3_OID, PBE_3DES_OID]) expect(out.includes(oid)).toBe(false)
  })

  it.skipIf(!hasOpenssl)('openssl reads the export', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gecko-p12-'))
    try {
      const file = join(dir, 'x.p12')
      writeFileSync(file, await buildP12(parts, 'yeni-parola-1234'))
      const out = execFileSync('openssl', ['pkcs12', '-in', file, '-passin', 'pass:yeni-parola-1234', '-noenc'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
      expect(out).toContain('BEGIN PRIVATE KEY')
      expect(out.match(/BEGIN CERTIFICATE/g)).toHaveLength(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('pkcs12Kdf', () => {
  it('işçi aynı sonucu verir ve olay döngüsünü tutmaz', async () => {
    const salt = Buffer.from('0102030405060708', 'hex')
    let ticks = 0
    const timer = setInterval(() => ticks++, 5)
    const out = await pkcs12KdfInWorker('sha1', PASS, salt, 400_000, 1, 24)
    clearInterval(timer)
    expect(out.equals(pkcs12Kdf('sha1', PASS, salt, 400_000, 1, 24))).toBe(true)
    expect(ticks).toBeGreaterThan(3)
  })

  const hex = (b: Buffer): string => b.toString('hex')

  it('matches openssl PKCS12KDF vectors', () => {
    expect(hex(pkcs12Kdf('sha1', 'smeg', Buffer.from('0a58cf64530d823f', 'hex'), 1, 1, 24))).toBe('8aaae6297b6cb04642ab5b077851284eb7128f1a2a7fbca3')
    expect(hex(pkcs12Kdf('sha256', 'gec', Buffer.from('0102030405060708', 'hex'), 2048, 3, 32))).toBe('aef972eff324367a3ad0545a90025ab46739b48e19b67d2bb804b23fb6a6719e')
  })
})
