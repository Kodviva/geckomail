import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

// paylaşılan şablonlar (owner NULL): senkron davranışı; kişiye ait olanlar userScope.test.ts'te
describe('şablonlar (R28)', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-tpl-'))
    q = makeQueries(openDb(dir))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('kaydet, üzerine yaz, sil; silinen listede görünmez ama senkronda mezar taşıdır', () => {
    q.saveTemplate({ name: 'Teşekkür', subject: null, body: 'Merhaba {{ad}}', shared: true }, null, 100)
    q.saveTemplate({ name: 'Teşekkür', subject: 'Konu', body: 'Merhaba {{ad}}, teşekkürler', shared: true }, null, 200)
    q.saveTemplate({ name: 'Red', subject: null, body: 'Maalesef', shared: true }, null, 150)
    expect(q.listTemplates(0).map((t) => t.name)).toEqual(['Red', 'Teşekkür'])
    q.deleteTemplate('Red', null, 300)
    expect(q.listTemplates(0).map((t) => t.name)).toEqual(['Teşekkür'])
    expect(q.templatesForSync(400)).toEqual([
      { name: 'Red', subject: null, body: '', updatedAt: 300, deleted: true },
      { name: 'Teşekkür', subject: 'Konu', body: 'Merhaba {{ad}}, teşekkürler', updatedAt: 200, deleted: false }
    ])
  })

  it('senkron birleştirme: ad başına son yazan kazanır; eski kopya silineni geri getirmez', () => {
    q.saveTemplate({ name: 'A', subject: null, body: 'yerel yeni', shared: true }, null, 500)
    q.saveTemplate({ name: 'B', subject: null, body: 'yerel', shared: true }, null, 100)
    q.deleteTemplate('C', null, 0) // yok — etkisiz
    q.saveTemplate({ name: 'C', subject: null, body: 'c', shared: true }, null, 100)
    q.deleteTemplate('C', null, 600)
    const applied = q.mergeSyncTemplates([
      { name: 'A', subject: null, body: 'uzak eski', updatedAt: 400, deleted: false },
      { name: 'B', subject: 'x', body: 'uzak yeni', updatedAt: 200, deleted: false },
      { name: 'C', subject: null, body: 'uzak eski c', updatedAt: 300, deleted: false },
      { name: 'D', subject: null, body: '', updatedAt: 250, deleted: true },
      { name: 'E', subject: null, body: 'yeni', updatedAt: 250, deleted: false }
    ])
    expect(applied).toBe(3) // B güncellendi, D mezar taşı, E yeni
    expect(q.listTemplates(0).map((t) => [t.name, t.body])).toEqual([
      ['A', 'yerel yeni'],
      ['B', 'uzak yeni'],
      ['E', 'yeni']
    ])
    // uzakta silinen yerelde de silinir
    q.mergeSyncTemplates([{ name: 'E', subject: null, body: '', updatedAt: 700, deleted: true }])
    expect(q.listTemplates(0).map((t) => t.name)).toEqual(['A', 'B'])
  })

  it('90 günden eski mezar taşları temizlenir', () => {
    q.saveTemplate({ name: 'X', subject: null, body: 'x', shared: true }, null, 0)
    q.deleteTemplate('X', null, 1000)
    expect(q.templatesForSync(1000 + 91 * 86_400_000)).toEqual([])
  })
})
