import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEY_BYTES, loadOrCreateMasterKey, openWithKey, sealWithKey } from '../keyfile'

describe('keyfile', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-key-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('seal/open roundtrip', () => {
    const key = loadOrCreateMasterKey(join(dir, 'master.key'))
    const blob = sealWithKey(key, Buffer.from('parola-123'))
    expect(Buffer.from(blob.subarray(0, 4)).toString()).toBe('GKS1')
    expect(Buffer.from(openWithKey(key, blob)).toString()).toBe('parola-123')
  })

  it('tampered tag throws gecko.key.badBlob', () => {
    const key = loadOrCreateMasterKey(join(dir, 'master.key'))
    const blob = Buffer.from(sealWithKey(key, Buffer.from('x')))
    blob[blob.length - 1] ^= 1
    expect(() => openWithKey(key, blob)).toThrow('gecko.key.badBlob')
    expect(() => openWithKey(key, Buffer.from('v10xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'))).toThrow('gecko.key.badBlob')
  })

  it('creates key with mode 0600', () => {
    const p = join(dir, 'master.key')
    const key = loadOrCreateMasterKey(p)
    expect(key.length).toBe(KEY_BYTES)
    expect(statSync(p).mode & 0o777).toBe(0o600)
    expect(loadOrCreateMasterKey(p).equals(key)).toBe(true)
  })

  it('rejects 0644 key file', () => {
    const p = join(dir, 'master.key')
    loadOrCreateMasterKey(p)
    chmodSync(p, 0o644)
    expect(() => loadOrCreateMasterKey(p)).toThrow('gecko.key.insecure')
  })

  it('rejects 31-byte key', () => {
    const p = join(dir, 'master.key')
    writeFileSync(p, Buffer.alloc(31, 1), { mode: 0o600 })
    expect(() => loadOrCreateMasterKey(p)).toThrow('gecko.key.size')
  })

  it('wrong key open throws gecko.key.badBlob', () => {
    const k1 = loadOrCreateMasterKey(join(dir, 'a.key'))
    const k2 = loadOrCreateMasterKey(join(dir, 'b.key'))
    expect(() => openWithKey(k2, sealWithKey(k1, Buffer.from('x')))).toThrow('gecko.key.badBlob')
  })

  it('truncated blob with valid prefix throws gecko.key.badBlob', () => {
    const key = loadOrCreateMasterKey(join(dir, 'master.key'))
    const blob = Buffer.concat([Buffer.from('GKS1'), Buffer.alloc(20, 1)])
    expect(blob.length).toBeLessThan(32)
    expect(() => openWithKey(key, blob)).toThrow('gecko.key.badBlob')
  })

  it('geçici dosya bırakmaz', () => {
    loadOrCreateMasterKey(join(dir, 'master.key'))
    expect(readdirSync(dir)).toEqual(['master.key'])
  })
})
