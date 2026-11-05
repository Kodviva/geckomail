// E-posta adresinden IMAP/SMTP sunucu ayarlarını otomatik çöz. Bilinen sağlayıcılar için
// tablo; bilinmeyen (kurumsal/cPanel) alan adları için mail.<domain> varsayılanı.
// Ağ autoconfig (Thunderbird ISPDB) yerine gömülü tablo — çevrimdışı, bağımlılıksız,
// büyük sağlayıcıların ~tamamını kapsar. Tablo yetmezse ISPDB fetch'i eklenebilir.

export interface MailServers {
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  label?: string // "Gmail" — algılandı göstergesi
  appPassword?: boolean // normal şifre bloklu, uygulama-özel şifre gerekir
}

const G = { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465, label: 'Gmail', appPassword: true }
const O = { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587, label: 'Outlook', appPassword: true }
const Y = { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465, label: 'Yahoo', appPassword: true }
const I = { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587, label: 'iCloud', appPassword: true }
const YA = { imapHost: 'imap.yandex.com', imapPort: 993, smtpHost: 'smtp.yandex.com', smtpPort: 465, label: 'Yandex' }

const PROVIDERS: Record<string, MailServers> = {
  'gmail.com': G,
  'googlemail.com': G,
  'outlook.com': O,
  'hotmail.com': O,
  'hotmail.co.uk': O,
  'live.com': O,
  'msn.com': O,
  'office365.com': O,
  'yahoo.com': Y,
  'yahoo.co.uk': Y,
  'ymail.com': Y,
  'icloud.com': I,
  'me.com': I,
  'mac.com': I,
  'aol.com': { imapHost: 'imap.aol.com', imapPort: 993, smtpHost: 'smtp.aol.com', smtpPort: 465, label: 'AOL', appPassword: true },
  'yandex.com': YA,
  'yandex.com.tr': YA,
  'zoho.com': { imapHost: 'imap.zoho.com', imapPort: 993, smtpHost: 'smtp.zoho.com', smtpPort: 465, label: 'Zoho' },
  'gmx.com': { imapHost: 'imap.gmx.com', imapPort: 993, smtpHost: 'mail.gmx.com', smtpPort: 465, label: 'GMX' },
  'mail.com': { imapHost: 'imap.mail.com', imapPort: 993, smtpHost: 'smtp.mail.com', smtpPort: 465, label: 'Mail.com' }
}

export function resolveMailServers(email: string): MailServers {
  const domain = (email.split('@')[1] ?? '').trim().toLowerCase()
  if (PROVIDERS[domain]) return PROVIDERS[domain]
  return { imapHost: `mail.${domain}`, imapPort: 993, smtpHost: `mail.${domain}`, smtpPort: 465 }
}
