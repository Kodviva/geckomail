import * as plist from 'plist'
import Papa from 'papaparse'
import { resolveMailServers } from '../shared/mailProviders'

export interface ImportedAccount {
  email: string
  displayName: string | null
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  password: string | null
  /** sunucu verilmedi ve sağlayıcı tablosunda yok: keşif (autodiscover) ile doldurulmalı */
  needsDiscovery?: boolean
}

export function parseMobileconfig(xml: string): ImportedAccount[] {
  const root = plist.parse(xml) as { PayloadContent?: Array<Record<string, unknown>> }
  const out: ImportedAccount[] = []
  for (const p of root.PayloadContent ?? []) {
    if (p.PayloadType !== 'com.apple.mail.managed') continue
    const email = String(p.EmailAddress ?? '').trim().toLowerCase()
    if (!email) continue
    out.push({
      email,
      displayName: p.EmailAccountName ? String(p.EmailAccountName) : null,
      imapHost: String(p.IncomingMailServerHostName ?? ''),
      imapPort: Number(p.IncomingMailServerPortNumber ?? 993),
      smtpHost: String(p.OutgoingMailServerHostName ?? p.IncomingMailServerHostName ?? ''),
      smtpPort: Number(p.OutgoingMailServerPortNumber ?? 465),
      password: p.IncomingPassword ? String(p.IncomingPassword) : p.OutgoingPassword ? String(p.OutgoingPassword) : null
    })
  }
  return out
}

// CSV kolonları: email,password[,imap_host,imap_port,smtp_host,smtp_port]
// host verilmezse sağlayıcıdan otomatik çözülür (Gmail/Outlook/… tablosu), yoksa mail.<domain>
export function parseCsv(text: string): ImportedAccount[] {
  const res = Papa.parse<Record<string, string>>(text.trim(), { header: true, skipEmptyLines: true })
  const out: ImportedAccount[] = []
  for (const row of res.data) {
    const email = (row.email ?? row.Email ?? row.EMAIL ?? '').trim().toLowerCase()
    if (!email || !email.includes('@')) continue
    const auto = resolveMailServers(email)
    const explicit = !!(row.imap_host ?? '').trim()
    out.push({
      email,
      displayName: null,
      imapHost: (row.imap_host ?? '').trim() || auto.imapHost,
      imapPort: Number(row.imap_port) || auto.imapPort,
      smtpHost: (row.smtp_host ?? '').trim() || (row.imap_host ?? '').trim() || auto.smtpHost,
      smtpPort: Number(row.smtp_port) || auto.smtpPort,
      password: (row.password ?? '').trim() || null,
      ...(!explicit && !auto.label ? { needsDiscovery: true } : {})
    })
  }
  return out
}

export function parseImport(kind: 'mobileconfig' | 'csv', content: string): ImportedAccount[] {
  return kind === 'mobileconfig' ? parseMobileconfig(content) : parseCsv(content)
}
