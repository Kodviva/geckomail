// Tekrarlayan bildirim maillerini (SLA/DMARC gibi) kümelemek için kalıp anahtarı:
// sayıları/ID'leri normalize eder ki "1 açık arıza" ile "3 açık arıza" aynı kalıba düşsün.
export function subjectTemplateKey(subject: string | null): string {
  if (!subject) return ''
  return subject
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
}
