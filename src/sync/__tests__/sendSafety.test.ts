import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries, type AccountRow } from '../db/queries'
import { smtpErrorKind } from '../opQueue'
import { runRulesForAccount } from '../rulesRunner'
import { createServer, type AddressInfo } from 'net'
import { composeRaw, FORWARD_MARK_HEADER, newMessageId, smtpSendRaw } from '../smtpSend'

describe('SMTP hata aşaması', () => {
  it('gönderirken ağ kopması belirsiz; sunucu kodlu ret kesin', () => {
    expect(smtpErrorKind({ code: 'ESOCKET', command: 'CONN', phase: 'send' })).toBe('uncertain')
    expect(smtpErrorKind({ code: 'ETIMEDOUT', phase: 'send' })).toBe('uncertain')
    expect(smtpErrorKind({ code: 'EMESSAGE', responseCode: 552, command: 'DATA', phase: 'send' })).toBe('other')
  })
  it('bağlanırken ağ hatası login-öncesi; girişte ret auth', () => {
    expect(smtpErrorKind({ code: 'ESOCKET', command: 'CONN', phase: 'connect' })).toBe('preauth')
    expect(smtpErrorKind({ code: 'EAUTH', responseCode: 535, phase: 'auth' })).toBe('auth')
    expect(smtpErrorKind({ code: 'ESOCKET', phase: 'auth' })).toBe('net')
  })
})

describe('kalıcı Message-ID ve iletme işareti', () => {
  const acc = { email: 'ops@test.co', display_name: 'Ops' } as AccountRow
  const draft = { accountId: 1, to: 'x@y.co', subject: 'Konu', text: 'Gövde' }

  it('aynı meta ile iki derleme aynı Message-ID ve tarihi taşır', async () => {
    const meta = { messageId: newMessageId(acc.email), date: 1_700_000_000_000 }
    const a = (await composeRaw(acc, draft, [], meta)).toString()
    const b = (await composeRaw(acc, draft, [], meta)).toString()
    const id = (s: string) => /^Message-ID: (.+)$/im.exec(s)?.[1]
    const date = (s: string) => /^Date: (.+)$/im.exec(s)?.[1]
    expect(id(a)).toBe(meta.messageId)
    expect(id(a)).toBe(id(b))
    expect(date(a)).toBe(date(b))
    expect(meta.messageId).toMatch(/^<[0-9a-f-]{36}@test\.co>$/)
  })
  it('otomatik iletilen maile işaret başlığı eklenir', async () => {
    const raw = (await composeRaw(acc, draft, [], { messageId: '<a@b>', date: 0, autoForwarded: true })).toString()
    expect(raw).toMatch(new RegExp(`^${FORWARD_MARK_HEADER}: 1`, 'im'))
    const plain = (await composeRaw(acc, draft, [], { messageId: '<a@b>', date: 0 })).toString()
    expect(plain).not.toMatch(new RegExp(FORWARD_MARK_HEADER, 'i'))
  })
})

describe('S/MIME yolu düz gönderimi değiştirmez', () => {
  const acc = { email: 'ops@test.co', display_name: 'Ops' } as AccountRow
  it('composeRaw kısa ASCII gövdeyi 7bit bırakır, Bcc başlığı yazmaz', async () => {
    const raw = (await composeRaw(acc, { accountId: 1, to: 'x@y.co', bcc: 'g@y.co', subject: 'K', text: 'düz' }, [], { messageId: '<a@b>', date: 0 })).toString()
    expect(raw).toMatch(/^Content-Type: text\/plain/im)
    expect(raw).not.toMatch(/^Bcc:/im)
    const ascii = (await composeRaw(acc, { accountId: 1, to: 'x@y.co', subject: 'K', text: 'plain' }, [], { messageId: '<a@b>', date: 0 })).toString()
    expect(ascii).toMatch(/^Content-Transfer-Encoding: 7bit/im)
  })
})

describe('forward döngü koruması (uçtan uca, gerçek DB)', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-fwd-'))
    q = makeQueries(openDb(dir))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('işaretli gelen mailde forward kuralı kuyruğa op eklemez; işaretsizde ekler', async () => {
    const acc = q.insertAccount({ email: 'a@t.co', displayName: null, imapHost: 'm.t.co', imapPort: 993, smtpHost: 'm.t.co', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const folder = q.upsertFolder(acc, 'INBOX', 'inbox')
    q.insertRule({ name: 'ilet', accountId: acc, groupId: null, conditions: { senderContains: 'b@t.co' }, actions: [{ type: 'forward', to: 'b@t.co' }] })
    const h = (uid: number, autoForwarded: boolean) => ({
      folderId: folder, accountId: acc, folderKind: 'inbox' as const, uid, messageId: `<m${uid}@t>`, inReplyTo: null,
      subject: 'İlt: rapor', fromName: null, fromAddr: 'b@t.co', toJson: null, date: 1, size: 1, seen: false, flagged: false,
      answered: false, hasAttachments: false, listUnsubscribe: null, listUnsubscribePost: null, rulesEligible: true, autoForwarded
    })
    q.upsertHeader(h(1, true))
    const opq = { kick() {} } as unknown as Parameters<typeof runRulesForAccount>[1]
    await runRulesForAccount(q, opq, acc, () => {})
    expect(q.dueOps(Date.now() + 1, 50).filter((o) => o.kind === 'forward')).toHaveLength(0)
    q.upsertHeader(h(2, false))
    await runRulesForAccount(q, opq, acc, () => {})
    expect(q.dueOps(Date.now() + 1, 50).filter((o) => o.kind === 'forward')).toHaveLength(1)
  })
})

describe('smtpSendRaw soket hatasında asılı kalmaz', () => {
  it('sunucu bağlantıyı hemen kapatırsa connect aşamasıyla reddeder', async () => {
    const srv = createServer((sock) => sock.destroy())
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
    const port = (srv.address() as AddressInfo).port
    const account = { email: 'a@t.co', smtp_host: '127.0.0.1', smtp_port: port, smtp_tls: 'starttls', allow_invalid_certs: 0 } as AccountRow
    const started = Date.now()
    const err = await smtpSendRaw(account, 'x', { accountId: 1, to: 'b@t.co', subject: 's', text: 't' }, Buffer.from('x')).catch((e) => e)
    srv.close()
    expect(err).toBeInstanceOf(Error)
    expect((err as { phase?: string }).phase).toBe('connect')
    expect(smtpErrorKind(err)).toBe('preauth')
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 20_000)
})
