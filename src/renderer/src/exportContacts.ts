import { t } from '../../shared/i18n'

// Bilinen kişileri CSV olarak dışa aktarma yardımcıları.
// `toCsv` saf ve test edilebilir (DOM yok); `exportContactsCsv` tarayıcıda indirmeyi tetikler.

export interface Contact {
  addr: string
  name: string | null
}

// Tek bir CSV alanını RFC 4180'e göre kaçışlar: alan virgül, çift tırnak veya satır
// sonu içeriyorsa çift tırnakla sarmalanır ve içteki tırnaklar ikiye katlanır.
function escapeField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

// Kişi listesinden CSV metni üretir. Başlık satırı `Ad,E-posta`, ardından her kişi
// için "önce ad, sonra e-posta" bir satır. Satırlar CRLF ile ayrılır.
export function toCsv(contacts: Contact[]): string {
  const rows: string[][] = [[t('mail.contacts.csvName'), t('mail.contacts.csvEmail')], ...contacts.map((c) => [c.name ?? '', c.addr])]
  return rows.map((cols) => cols.map(escapeField).join(',')).join('\r\n')
}

// CSV üretip tarayıcıda `kisiler.csv` olarak indirir. Sandbox'lı renderer, geçici bir
// `<a download>` öğesini tıklayarak Blob indirmesini tetikleyebilir — preload köprüsü gerekmez.
export function exportContactsCsv(contacts: Contact[]): void {
  const blob = new Blob([toCsv(contacts)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = t('mail.contacts.csvFile')
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
