import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ContactDetail, ContactDraft, ContactSummary } from '../../shared/pim'
import type { Contact } from '../../shared/rpc'
import { parseCard, splitVcf } from '../pim/vcard'
import { contactsHandlers as h } from '../rpc/contacts'
import { mailHandlers } from '../rpc/mail'
import { pimSourcesHandlers } from '../rpc/pimSources'
import { buildGateWorker, removeGateWorkers } from './helpers/gateWorker'
import { BOOK, pimHarness, type PimHarness } from './helpers/pimHarness'

const vcf = (uid: string, name: string, email: string, more: string[] = []): string =>
  ['BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${name}`, `EMAIL:${email}`, ...more, 'END:VCARD', ''].join('\r\n')
const draft = (o: Partial<ContactDraft> = {}): ContactDraft => ({
  fullName: 'Ayşe Kaya', given: 'Ayşe', family: 'Kaya', org: null, emails: [{ addr: 'ayse@x.co', label: null }], phones: [], addresses: [], note: null, birthday: null, kind: 'individual', ...o
})

describe('kişi RPC', () => {
  let worker: string
  let t: PimHarness
  beforeAll(() => {
    worker = buildGateWorker()
  })
  afterAll(removeGateWorkers)
  beforeEach(async () => {
    t = await pimHarness(worker)
  })
  afterEach(() => t.close())

  const seeded = async (): Promise<void> => {
    t.dav.seed(`${BOOK}1.vcf`, vcf('u1', 'Ali Veli', 'ali@x.co'))
    t.dav.seed(`${BOOK}2.vcf`, vcf('u2', 'İpek Işık', 'ipek@x.co'))
    await t.sync()
  }
  const idOf = (uid: string): number => (t.db.prepare(`SELECT id FROM contacts WHERE uid = ?`).get(uid) as { id: number }).id
  const contacts = (user: number): Promise<Contact[]> => mailHandlers.getContacts(t.session(user), {}) as Promise<Contact[]>
  const collected = (from: string, name: string): void => {
    const f = t.db.prepare(`INSERT INTO folders (account_id, path, kind, special_use) VALUES (?, 'INBOX', 'inbox', 1)
      ON CONFLICT DO UPDATE SET kind = kind RETURNING id`).get(t.acc) as { id: number }
    t.db.prepare(`INSERT INTO messages (folder_id, account_id, folder_kind, uid, message_id, subject, from_name, from_addr, to_json, date, size, seen, preview, thread_root)
      VALUES (?, ?, 'inbox', (SELECT COALESCE(MAX(uid), 0) + 1 FROM messages), ?, 's', ?, ?, '[]', 1, 1, 1, '', '')`).run(f.id, t.acc, `<${from}>`, name, from)
  }

  it('every contacts method denies member without access', async () => {
    await seeded()
    const book = t.book().id
    const id = idOf('u1')
    const calls: Record<string, unknown> = {
      listContacts: { collectionIds: [book] }, getContact: { id }, saveContact: { collectionId: book, draft: draft() }, deleteContact: { id }, importContacts: { collectionId: book, vcards: vcf('z', 'z', 'z@x.co') },
      exportContacts: { collectionId: book }, promoteCollected: { addr: 'q@x.co', name: null, collectionId: book }, mergeContacts: { keepId: id, dropIds: [idOf('u2')] }
    }
    expect(Object.keys(calls).sort()).toEqual(Object.keys(h).sort())
    for (const [name, params] of Object.entries(calls)) await expect(h[name](t.session(t.stranger), params), name).rejects.toThrow()
    expect(await h.listContacts(t.session(t.stranger), { collectionIds: null })).toEqual([])
    expect(t.dav.requests.filter((r) => r.method === 'PUT' || r.method === 'DELETE')).toEqual([])
  })

  it('view-only member cannot save', async () => {
    await seeded()
    const s = t.session(t.viewer)
    expect(await h.listContacts(s, { collectionIds: null })).toHaveLength(2)
    await expect(h.saveContact(s, { collectionId: t.book().id, draft: draft() })).rejects.toThrow()
    await expect(h.deleteContact(s, { id: idOf('u1') })).rejects.toThrow()
  })

  it('listContacts sayfalar, Türkçe i duyarsız arar, gizli defteri atlar', async () => {
    await seeded()
    const s = t.session(t.admin)
    const first = (await h.listContacts(s, { collectionIds: null, limit: 1 })) as ContactSummary[]
    expect(first.map((c) => c.fullName)).toEqual(['Ali Veli'])
    expect(first[0].emails).toEqual([{ addr: 'ali@x.co', label: null }])
    const rest = (await h.listContacts(s, { collectionIds: null, limit: 5, cursor: { name: first[0].fullName, id: first[0].id } })) as ContactSummary[]
    expect(rest.map((c) => c.fullName)).toEqual(['İpek Işık'])
    expect(((await h.listContacts(s, { collectionIds: null, query: 'IPEK işik' })) as ContactSummary[]).map((c) => c.id)).toEqual([idOf('u2')])
    expect(((await h.listContacts(s, { collectionIds: null, query: 'ALI@X' })) as ContactSummary[]).map((c) => c.id)).toEqual([idOf('u1')])
    await pimSourcesHandlers.setPimCollectionPref(s, { collectionId: t.book().id, hidden: true })
    expect(await h.listContacts(s, { collectionIds: null })).toEqual([])
    expect(await h.listContacts(s, { collectionIds: [t.book().id] })).toHaveLength(2)
    await expect(h.listContacts(s, { collectionIds: null, limit: 201 })).rejects.toThrow()
  })

  it('getContacts unchanged without sources', async () => {
    collected('x@y.co', 'X')
    t.db.prepare(`DELETE FROM pim_sources`).run()
    expect(await contacts(t.admin)).toEqual([{ addr: 'x@y.co', name: 'X' }])
  })

  it('card name wins over collected', async () => {
    collected('ALI@x.co', 'eski ad')
    await seeded()
    const list = await contacts(t.admin)
    expect(list.filter((c) => c.addr.toLowerCase() === 'ali@x.co')).toEqual([{ addr: 'ali@x.co', name: 'Ali Veli', contactId: idOf('u1') }])
  })

  it('member sees collected only from own accounts', async () => {
    collected('x@y.co', 'X')
    await seeded()
    expect(await contacts(t.stranger)).toEqual([])
    expect((await contacts(t.viewer)).map((c) => c.addr)).toContain('x@y.co')
  })

  it('hidden collection not in autocomplete', async () => {
    await seeded()
    const s = t.session(t.viewer)
    await pimSourcesHandlers.setPimCollectionPref(s, { collectionId: t.book().id, hidden: true })
    expect(await contacts(t.viewer)).toEqual([])
    expect(await contacts(t.admin)).toHaveLength(2)
  })

  it('vault mail still excluded', async () => {
    collected('kasa@y.co', 'K')
    t.db.prepare(`UPDATE messages SET enc = 1`).run()
    await seeded()
    expect((await contacts(t.admin)).map((c) => c.addr)).not.toContain('kasa@y.co')
  })

  it('group expands to members', async () => {
    t.dav.seed(`${BOOK}1.vcf`, vcf('u1', 'Ali', 'ali@x.co'))
    t.dav.seed(`${BOOK}2.vcf`, vcf('u2', 'Can', 'can@x.co'))
    t.dav.seed(`${BOOK}g.vcf`, ['BEGIN:VCARD', 'VERSION:3.0', 'UID:g1', 'FN:Ekip', 'X-ADDRESSBOOKSERVER-KIND:group', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:u1', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:u2', 'X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:yok', 'END:VCARD', ''].join('\r\n'))
    await t.sync()
    const [first, ...rest] = await contacts(t.admin)
    expect(first).toMatchObject({ name: 'Ekip', groupId: idOf('g1') })
    expect(first.members?.sort()).toEqual(['ali@x.co', 'can@x.co'])
    expect(rest.map((c) => c.addr).sort()).toEqual(['ali@x.co', 'can@x.co'])
    const detail = (await h.getContact(t.session(t.admin), { id: idOf('g1') })) as ContactDetail
    expect(detail.memberIds.sort()).toEqual([idOf('u1'), idOf('u2')].sort())
  })

  it('kaydeder, etag sunucudan gelmezse yeniden alır, güncelleme If-Match gönderir', async () => {
    await t.sync()
    const s = t.session(t.manager)
    const made = (await h.saveContact(s, { collectionId: t.book().id, draft: draft() })) as { ok: true; id: number; etag: string }
    expect(made).toMatchObject({ ok: true })
    const put = t.dav.requests.find((r) => r.method === 'PUT')!
    expect(put.headers['if-none-match']).toBe('*')
    expect(made.etag).toBeTruthy()
    const up = await h.saveContact(s, { collectionId: t.book().id, id: made.id, etag: made.etag, draft: draft({ fullName: 'Ayşe Demir' }) })
    expect(up).toMatchObject({ ok: true, id: made.id })
    expect(t.dav.requests.filter((r) => r.method === 'PUT')[1].headers['if-match']).toBe(made.etag)
    expect(t.db.prepare(`SELECT full_name FROM contacts WHERE id = ?`).get(made.id)).toEqual({ full_name: 'Ayşe Demir' })
    t.dav.override('PUT', put.path, { status: 201 })
    const noEtag = (await h.saveContact(s, { collectionId: t.book().id, id: made.id, draft: draft({ fullName: 'Üçüncü' }) })) as { etag: string | null }
    expect(noEtag.etag).toBe(t.dav.objects.get(put.path)!.etag)
  })

  it('save conflict returns conflict and keeps local', async () => {
    await seeded()
    const id = idOf('u1')
    const res = await h.saveContact(t.session(t.manager), { collectionId: t.book().id, id, etag: '"eski"', draft: draft({ fullName: 'Yeni' }) })
    expect(res).toEqual({ ok: false, conflict: true })
    expect(t.db.prepare(`SELECT full_name FROM contacts WHERE id = ?`).get(id)).toEqual({ full_name: 'Ali Veli' })
    expect(await h.deleteContact(t.session(t.manager), { id, etag: '"eski"' })).toEqual({ ok: false, conflict: true })
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get()).toEqual({ n: 2 })
  })

  it('siler; reddedilen kimlik kaynağı durdurur, sonraki yazma sunucuya gitmez', async () => {
    await seeded()
    const s = t.session(t.manager)
    expect(await h.deleteContact(s, { id: idOf('u1') })).toEqual({ ok: true })
    expect(t.dav.objects.has(`${BOOK}1.vcf`)).toBe(false)
    t.dav.accept = ['baska']
    await expect(h.saveContact(s, { collectionId: t.book().id, draft: draft() })).rejects.toThrow()
    expect(t.q.getPimSource(t.source.id)?.status).toBe('needs_reauth')
    const n = t.dav.requests.length
    await expect(h.saveContact(s, { collectionId: t.book().id, draft: draft() })).rejects.toThrow()
    expect(t.dav.requests).toHaveLength(n)
  })

  it('import skips same uid', async () => {
    await seeded()
    const r = await h.importContacts(t.session(t.manager), { collectionId: t.book().id, vcards: vcf('u1', 'Tekrar', 'a@x.co') + vcf('u9', 'Yeni', 'y@x.co') + vcf('u9', 'Aynı', 'y2@x.co') })
    expect(r).toEqual({ added: 1, skipped: 2, failed: 0 })
    expect(t.db.prepare(`SELECT full_name FROM contacts WHERE uid = 'u1'`).get()).toEqual({ full_name: 'Ali Veli' })
  })


  it('import failed counted', async () => {
    await t.sync()
    const bad = 'BEGIN:VCARD\r\nFN;bozuk\r\nEND:VCARD\r\n'
    const r = await h.importContacts(t.session(t.manager), { collectionId: t.book().id, vcards: vcf('a', 'A', 'a@x.co') + bad })
    expect(r).toEqual({ added: 1, skipped: 0, failed: 1 })
  })

  it('import uzak sunucu hatasında sayar ve sürer', async () => {
    await t.sync()
    let n = 0
    const s = t.session(t.manager)
    t.dav.onPut = () => (n++ === 0 ? { status: 500 } : null)
    const r = await h.importContacts(s, { collectionId: t.book().id, vcards: vcf('a', 'A', 'a@x.co') + vcf('b', 'B', 'b@x.co') })
    expect(r).toEqual({ added: 1, skipped: 0, failed: 1 })
  })

  it('import kimlik reddinde hemen durur', async () => {
    await t.sync()
    const s = t.session(t.manager)
    const before = t.dav.requests.length
    t.dav.accept = ['baska']
    const r = (await h.importContacts(s, { collectionId: t.book().id, vcards: Array.from({ length: 12 }, (_, i) => vcf(`i${i}`, `I${i}`, `i${i}@x.co`)).join('') })) as { added: number; failed: number }
    expect(r).toMatchObject({ added: 0, failed: 12 })
    expect(t.dav.requests.length - before).toBeLessThanOrEqual(4)
  })

  it('export roundtrips via parseCard', async () => {
    await seeded()
    const r = (await h.exportContacts(t.session(t.viewer), { collectionId: t.book().id })) as { filename: string; data: Uint8Array }
    expect(r.filename).toMatch(/\.vcf$/)
    const cards = splitVcf(Buffer.from(r.data).toString()).map(parseCard)
    expect(cards.map((c) => c?.uid).sort()).toEqual(['u1', 'u2'])
  })

  it('promote creates card, collected row deduped', async () => {
    collected('yeni@y.co', 'Yeni Kişi')
    await t.sync()
    const r = (await h.promoteCollected(t.session(t.manager), { addr: 'yeni@y.co', name: 'Yeni Kişi', collectionId: t.book().id })) as { id: number }
    const again = (await h.promoteCollected(t.session(t.manager), { addr: 'YENI@y.co', name: null, collectionId: t.book().id })) as { id: number }
    expect(again.id).toBe(r.id)
    expect(await contacts(t.admin)).toEqual([{ addr: 'yeni@y.co', name: 'Yeni Kişi', contactId: r.id }])
    await expect(h.promoteCollected(t.session(t.manager), { addr: 'gecersiz', name: null, collectionId: t.book().id })).rejects.toThrow()
  })

  it('merge unions emails and removes others', async () => {
    t.dav.seed(`${BOOK}1.vcf`, vcf('u1', 'Ali', 'ali@x.co', ['TEL:111']))
    t.dav.seed(`${BOOK}2.vcf`, vcf('u2', 'Ali V', 'ali@x.co', ['EMAIL:ali2@x.co', 'TEL:222', 'ORG:Şirket']))
    await t.sync()
    const keep = idOf('u1')
    expect(await h.mergeContacts(t.session(t.manager), { keepId: keep, dropIds: [idOf('u2')] })).toEqual({ ok: true, id: keep })
    const d = (await h.getContact(t.session(t.manager), { id: keep })) as ContactDetail
    expect(d.emails.map((e) => e.addr)).toEqual(['ali@x.co', 'ali2@x.co'])
    expect(d.phones.map((p) => p.value)).toEqual(['111', '222'])
    expect(d.org).toBe('Şirket')
    expect(t.dav.objects.has(`${BOOK}2.vcf`)).toBe(false)
    expect(t.db.prepare(`SELECT COUNT(*) AS n FROM contacts`).get()).toEqual({ n: 1 })
  })

  it('merge başka defterdeki kartı kabul etmez', async () => {
    await seeded()
    const s = t.session(t.manager)
    const local = await pimSourcesHandlers.listPimCollections(t.session(t.manager), { type: 'addressbook' }) as { id: number; sourceId: number }[]
    const mine = local.find((c) => c.sourceId !== t.source.id)!
    const made = (await h.saveContact(s, { collectionId: mine.id, draft: draft() })) as { id: number }
    await expect(h.mergeContacts(s, { keepId: made.id, dropIds: [idOf('u1')] })).rejects.toThrow()
  })

  it('yerel defter sunucusuz yazar', async () => {
    const s = t.session(t.viewer)
    const list = await pimSourcesHandlers.listPimCollections(s, { type: 'addressbook' }) as { id: number; sourceId: number }[]
    const mine = list.find((c) => c.sourceId !== t.source.id)!
    const n = t.dav.requests.length
    const made = (await h.saveContact(s, { collectionId: mine.id, draft: draft({ kind: 'individual' }) })) as { ok: true; id: number }
    expect(made.ok).toBe(true)
    const group = (await h.saveContact(s, { collectionId: mine.id, draft: draft({ kind: 'group', fullName: 'Ekip', emails: [], memberIds: [made.id] }) })) as { ok: true; id: number }
    const d = (await h.getContact(s, { id: group.id })) as ContactDetail
    expect(d).toMatchObject({ kind: 'group', memberIds: [made.id] })
    expect(t.dav.requests).toHaveLength(n)
  })

  it('html in note returned as text', async () => {
    t.dav.seed(`${BOOK}1.vcf`, vcf('u1', 'Ali', 'ali@x.co', ['NOTE:<img src=x onerror=alert(1)>']))
    await t.sync()
    const d = (await h.getContact(t.session(t.admin), { id: idOf('u1') })) as ContactDetail
    expect(d.note).toBe('<img src=x onerror=alert(1)>')
  })

  it('Google defterinde grup yazılamaz', async () => {
    await t.sync()
    t.db.prepare(`UPDATE accounts SET auth_type = 'oauth:google' WHERE id = ?`).run(t.acc)
    t.hub.deps.creds.delete(t.acc)
    await expect(h.saveContact(t.session(t.manager), { collectionId: t.book().id, draft: draft({ kind: 'group', memberIds: [] }) })).rejects.toThrow()
  })
})
