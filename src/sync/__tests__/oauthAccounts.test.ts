import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../db'
import { makeQueries } from '../db/queries'

describe('OAuth hesapları (DB)', () => {
  let dir: string
  let q: ReturnType<typeof makeQueries>
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gecko-oauth-'))
    q = makeQueries(openDb(dir))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('varsayılan şifre; OAuth ile eklenen hesap türünü taşır; 587 STARTTLS', () => {
    const p = q.insertAccount({ email: 'a@firma.co', displayName: null, imapHost: 'm', imapPort: 993, smtpHost: 'm', smtpPort: 465, passwordEnc: Buffer.from('x') })
    const o = q.insertAccount({
      email: 'b@outlook.com', displayName: null, imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587,
      passwordEnc: Buffer.from('rt'), authType: 'oauth:microsoft'
    })
    expect(q.getAccountRow(p)!.auth_type).toBe('password')
    expect(q.getAccountRow(o)).toMatchObject({ auth_type: 'oauth:microsoft', smtp_tls: 'starttls' })
    expect(q.getAccountInfos().find((a) => a.id === o)!.authType).toBe('oauth:microsoft')
  })

  it("şifreli Gmail hesabı OAuth'a geçer: tür, sır ve sağlayıcı sunucuları birlikte", () => {
    const id = q.insertAccount({ email: 'a@gmail.com', displayName: null, imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 587, passwordEnc: Buffer.from('app-pass') })
    q.setAccountOAuth(id, { authType: 'oauth:google', secretEnc: Buffer.from('rt'), imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 })
    expect(q.getAccountRow(id)).toMatchObject({ auth_type: 'oauth:google', smtp_port: 465, smtp_tls: 'tls', imap_tls: 'tls' })
    expect(q.getAccountRow(id)!.password_enc.toString()).toBe('rt')
  })

  it('cihaz senkronu türü taşır; eski blob (tür yok) şifre sayılır', () => {
    const base = { displayName: null, imapHost: 'imap.gmail.com', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.gmail.com', smtpPort: 465, smtpTls: 'tls', color: '#000', signature: null, allowInvalidCerts: false, groupId: null }
    const { id } = q.upsertSyncAccount({ ...base, email: 'a@gmail.com', password: { enc: Buffer.from('rt'), changedAt: 1 }, authType: 'oauth:google' })
    expect(q.getAccountRow(id)!.auth_type).toBe('oauth:google')
    expect(q.getSyncExport().accounts[0].authType).toBe('oauth:google')
    q.upsertSyncAccount({ ...base, email: 'a@gmail.com', password: { enc: Buffer.from('pw'), changedAt: 2 } })
    expect(q.getAccountRow(id)!.auth_type).toBe('password')
  })
})
