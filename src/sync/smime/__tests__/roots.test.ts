import { X509Certificate, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseCert } from '../certInfo'
import { createTrustStore } from '../trust'
import type { Queries } from '../../db/queries'

const pemPath = fileURLToPath(new URL('../roots/mozilla-email-roots.pem', import.meta.url))
const metaPath = fileURLToPath(new URL('../roots/roots-meta.json', import.meta.url))

describe('Mozilla e-posta kökleri', () => {
  const pem = readFileSync(pemPath)
  const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { fetchedAt: string; sha256: string; count: number }
  const blocks: string[] = pem.toString().match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []

  it('her PEM ayrışır, kopya yok, en az 50', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(50)
    const fps = blocks.map((b) => {
      const c = parseCert(new X509Certificate(b).raw)
      expect(c.ca).toBe(true)
      return c.fingerprint
    })
    expect(new Set(fps).size).toBe(fps.length)
  })

  it('meta dosyayla eşit', () => {
    expect(meta.count).toBe(blocks.length)
    expect(createHash('sha256').update(pem).digest('hex')).toBe(meta.sha256)
    expect(Number.isNaN(Date.parse(meta.fetchedAt))).toBe(false)
  })

  it('güven deposu kökleri DB ile birleştirir', () => {
    const der = new X509Certificate(blocks[0]).raw
    const extra = new X509Certificate(readFileSync(fileURLToPath(new URL('./fixtures/root.crt', import.meta.url)))).raw
    let rows = [{ fingerprint: 'fp', cert_der: Buffer.from(extra), label: 'Kurum', added_by: null, created_at: 1 }]
    const store = createTrustStore({ listAnchors: () => rows } as unknown as Queries)
    expect(store.bundle()).toMatchObject({ count: meta.count, sha256: meta.sha256 })
    expect(store.anchors()).toHaveLength(meta.count + 1)
    expect(store.anchors().some((a) => a.fingerprint === parseCert(der).fingerprint)).toBe(true)
    rows = []
    expect(store.anchors()).toHaveLength(meta.count)
  })
})
