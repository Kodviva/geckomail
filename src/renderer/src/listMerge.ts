// R25: arka plan tazelemesinde yalnız ilk sayfa çekilir; bu yardımcı taze ilk sayfayı yüklü listenin
// kuyruğuyla birleştirir. Sıra sunucudakiyle aynı: date DESC, id DESC.
export interface Sortable {
  id: number
  date: number
}

/** fresh: taze ilk sayfa; loaded: ekrandaki liste. Kuyruktan ilk sayfada olanlar ve ilk sayfanın
 *  en eskisinden yeni olanlar (artık ilk sayfada değilse silinmiş/taşınmıştır) atılır. */
export function mergeFirstPage<T extends Sortable>(fresh: T[], loaded: T[]): T[] {
  if (!fresh.length) return []
  const seen = new Set(fresh.map((r) => r.id))
  const oldest = fresh[fresh.length - 1]
  const rest = loaded.filter((m) => !seen.has(m.id) && (m.date < oldest.date || (m.date === oldest.date && m.id < oldest.id)))
  return [...fresh, ...rest]
}
