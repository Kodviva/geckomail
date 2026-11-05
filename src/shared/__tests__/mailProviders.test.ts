import { describe, expect, it } from 'vitest'
import { resolveMailServers } from '../mailProviders'

describe('resolveMailServers', () => {
  it('bilinen sağlayıcıları doğru çözer + uygulama-şifresi işaretler', () => {
    expect(resolveMailServers('a@gmail.com')).toMatchObject({ imapHost: 'imap.gmail.com', imapPort: 993, label: 'Gmail', appPassword: true })
    expect(resolveMailServers('b@hotmail.com').imapHost).toBe('outlook.office365.com')
    expect(resolveMailServers('c@me.com').imapHost).toBe('imap.mail.me.com')
    expect(resolveMailServers('d@yandex.com.tr').label).toBe('Yandex')
  })
  it('bilinmeyen alan adı için mail.<domain> varsayılanı, uyarı yok', () => {
    const r = resolveMailServers('x@firma.com.tr')
    expect(r).toMatchObject({ imapHost: 'mail.firma.com.tr', smtpHost: 'mail.firma.com.tr', imapPort: 993, smtpPort: 465 })
    expect(r.label).toBeUndefined()
    expect(r.appPassword).toBeUndefined()
  })
  it('büyük/küçük harf duyarsız', () => {
    expect(resolveMailServers('User@GMAIL.COM').imapHost).toBe('imap.gmail.com')
  })
})
