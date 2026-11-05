import { describe, expect, it } from 'vitest'
import { parseCsv, parseMobileconfig } from '../importers'

const FAKE_MOBILECONFIG = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.mail.managed</string>
      <key>EmailAddress</key><string>Test@Example.com</string>
      <key>EmailAccountName</key><string>Test Hesap</string>
      <key>IncomingMailServerHostName</key><string>mail.example.com</string>
      <key>IncomingMailServerPortNumber</key><integer>993</integer>
      <key>IncomingMailServerUsername</key><string>test@example.com</string>
      <key>IncomingPassword</key><string>fake-password-123</string>
      <key>OutgoingMailServerHostName</key><string>mail.example.com</string>
      <key>OutgoingMailServerPortNumber</key><integer>465</integer>
    </dict>
    <dict>
      <key>PayloadType</key><string>com.apple.security.something-else</string>
    </dict>
    <dict>
      <key>PayloadType</key><string>com.apple.mail.managed</string>
      <key>EmailAddress</key><string>nopass@example.com</string>
      <key>IncomingMailServerHostName</key><string>mail.example.com</string>
    </dict>
  </array>
</dict>
</plist>`

describe('parseMobileconfig', () => {
  it('mail payload’larını çıkarır, diğerlerini atlar', () => {
    const rows = parseMobileconfig(FAKE_MOBILECONFIG)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({
      email: 'test@example.com', // küçük harfe çevrilir
      displayName: 'Test Hesap',
      imapHost: 'mail.example.com',
      imapPort: 993,
      smtpHost: 'mail.example.com',
      smtpPort: 465,
      password: 'fake-password-123'
    })
    expect(rows[1].password).toBeNull()
    expect(rows[1].smtpPort).toBe(465) // varsayılan
  })
})

describe('parseCsv', () => {
  it('tam kolonlarla okur', () => {
    const rows = parseCsv('email,password,imap_host,imap_port,smtp_host,smtp_port\na@x.com,pw1,m.x.com,143,s.x.com,587\n')
    expect(rows).toEqual([
      { email: 'a@x.com', displayName: null, imapHost: 'm.x.com', imapPort: 143, smtpHost: 's.x.com', smtpPort: 587, password: 'pw1' }
    ])
  })

  it('host verilmezse mail.<domain> varsayar, bozuk satırı atlar', () => {
    const rows = parseCsv('email,password\nb@firma.com,gizli\nbozuk-satir,\n')
    expect(rows).toHaveLength(1)
    expect(rows[0].imapHost).toBe('mail.firma.com')
    expect(rows[0].imapPort).toBe(993)
    expect(rows[0].smtpHost).toBe('mail.firma.com')
  })
})
