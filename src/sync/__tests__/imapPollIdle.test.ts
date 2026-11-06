import { mkdtempSync, rmSync } from 'fs'
import type { ImapFlow } from 'imapflow'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'
import { ensureFolders, pollFolder } from '../imapPoll'

/** imapflow'un gerçek davranışı: EXISTS yalnız mailbox.exists'i günceller; uidNext ve highestModseq SELECT'te kalır, kilit yeniden
 *  seçmez. STATUS ve UID'li FETCH yanıtı uidNext'i ilerletir. `staleStatus`: seçili klasörde STATUS eski değer döndüren sunucu */
class Server {
  uids: number[]
  modseq = 10n
  mailbox: { path: string; uidValidity: bigint; uidNext: number; exists: number; highestModseq: bigint }
  statusCalls = 0
  staleStatus = false
  fetched: string[] = []
  constructor(count: number) {
    this.uids = Array.from({ length: count }, (_, i) => i + 1)
    this.mailbox = { path: 'INBOX', uidValidity: 1n, uidNext: count + 1, exists: count, highestModseq: this.modseq }
  }
  get realNext(): number {
    return (this.uids.at(-1) ?? 0) + 1
  }
  /** IDLE sırasında posta düştü: yalnız `* n EXISTS` gelir */
  deliver(): void {
    this.uids.push(this.realNext)
    this.modseq++
    this.mailbox.exists = this.uids.length
  }
  async *fetch(range: string) {
    this.fetched.push(range)
    const [a, b] = range.split(':')
    const from = Number(a)
    const to = b === '*' ? Infinity : Number(b)
    const hits = this.uids.filter((u) => u >= from && u <= to)
    // 'X:*' tuhaflığı: X son uid'den büyükse en yüksek uid'li ileti döner
    const list = hits.length || b !== '*' ? hits : this.uids.slice(-1)
    for (const uid of list) {
      if (uid >= this.mailbox.uidNext) this.mailbox.uidNext = uid + 1
      yield { uid, envelope: { messageId: `<m${uid}@t>`, subject: `s${uid}`, from: [{ address: 'x@y.co' }], date: new Date(1_700_000_000_000 + uid) }, flags: new Set<string>(), size: 10 }
    }
  }
  status = async (): Promise<{ path: string; uidNext: number; highestModseq: bigint }> => {
    this.statusCalls++
    if (this.staleStatus) return { path: 'INBOX', uidNext: this.mailbox.uidNext, highestModseq: this.mailbox.highestModseq }
    this.mailbox.uidNext = this.realNext
    this.mailbox.highestModseq = this.modseq
    return { path: 'INBOX', uidNext: this.realNext, highestModseq: this.modseq }
  }
  client(): ImapFlow {
    return {
      mailbox: this.mailbox, // STATUS ve FETCH aynı nesneyi günceller
      getMailboxLock: async () => ({ release() {} }), // açık klasör yeniden seçilmez
      status: this.status,
      search: async () => this.uids,
      fetch: (range: string) => this.fetch(range)
    } as unknown as ImapFlow
  }
}

describe('açık oturumda yeni posta', () => {
  let dir: string
  let db: ReturnType<typeof openDb>
  let q: ReturnType<typeof makeQueries>
  let acc: number
  let folder: number
  const poll = (s: Server) => pollFolder(q, q.getAccountRow(acc)!, q.getFolderById(folder)!, s.client(), 1)
  const synced = async (count = 3): Promise<Server> => {
    const s = new Server(count)
    await poll(s) // ilk senkron
    return s
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-idle-'))
    db = openDb(dir)
    q = makeQueries(db)
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    folder = q.upsertFolder(acc, 'INBOX', 'inbox')
  })
  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('EXISTS sonrası mailbox.uidNext eski olsa da posta aynı turda gelir', async () => {
    const s = await synced()
    s.deliver()
    const stale = s.mailbox.uidNext
    expect(stale).toBe(4)
    expect(s.realNext).toBe(5)
    const r = await poll(s)
    expect(r).toMatchObject({ changed: true, newInboxMessages: 1 })
    expect(q.getFolderById(folder)?.last_seen_uidnext).toBe(5)
    expect(q.pendingRuleMessages(acc, 10).map((m) => m.uid)).toEqual([4])
  })

  it('STATUS bayat dönse de sayı artışı `son:*` ile çeker, işaret gerçek uid\'e ilerler', async () => {
    const s = await synced()
    s.staleStatus = true
    s.deliver()
    s.deliver()
    const r = await poll(s)
    expect(r.newInboxMessages).toBe(2)
    expect(s.fetched.at(-1)).toBe('4:*')
    expect(q.getFolderById(folder)?.last_seen_uidnext).toBe(6)
    expect((await poll(s)).newInboxMessages).toBe(0)
  })

  it('değişiklik yokken `*` tuhaflığı yeni posta üretmez', async () => {
    const s = await synced()
    expect((await poll(s)).newInboxMessages).toBe(0)
    expect(q.getFolderById(folder)?.last_seen_uidnext).toBe(4)
  })

  it('highestModseq de STATUS\'ten tazelenir', async () => {
    const s = await synced()
    s.modseq = 50n
    await poll(s)
    expect(q.getFolderById(folder)?.highest_modseq).toBe(50)
  })

  it('STATUS reddedilirse (false) yoklama seçim değerleriyle sürer', async () => {
    const s = await synced()
    s.deliver()
    const c = s.client()
    ;(c as unknown as { status: () => Promise<boolean> }).status = async () => false
    const r = await pollFolder(q, q.getAccountRow(acc)!, q.getFolderById(folder)!, c, 1)
    expect(r.newInboxMessages).toBe(1) // sayı artışı yine yakalar
  })
})

describe('Çöp Kutusu algılama', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  let acc: number
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-kind-'))
    q = makeQueries(openDb(dir))
    acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const kinds = async (paths: string[]): Promise<Record<string, string>> => {
    const client = { list: async () => [{ path: 'INBOX' }, ...paths.map((path) => ({ path }))] } as unknown as ImapFlow
    const rows = await ensureFolders(q, q.getAccountRow(acc)!, client)
    return Object.fromEntries(rows.map((f) => [f.path, f.kind]))
  }

  it.each(['Çöp Kutusu', 'INBOX.Silinenler', 'Papierkorb', 'Corbeille', 'Papelera', 'INBOX/Lixeira', 'Корзина', 'المحذوفات', 'ट्रैश', 'ゴミ箱', '已删除', 'Deleted', 'INBOX.Deleted Items', 'TRASH'])('%s', async (p) => {
    expect((await kinds([p]))[p]).toBe('trash')
  })

  it('NFD yazılmış ad da eşleşir (macOS)', async () => {
    const p = 'Çöp Kutusu'.normalize('NFD')
    expect((await kinds([p]))[p]).toBe('trash')
  })

  it.each(['Projeler/Trash', 'Projeler.Silinenler', '垃圾箱', 'Çöpler', 'Silinecekler'])('%s Çöp Kutusu sayılmaz: içindeki silme kalıcı olurdu', async (p) => {
    expect((await kinds([p]))[p]).toBe('other')
  })
})
