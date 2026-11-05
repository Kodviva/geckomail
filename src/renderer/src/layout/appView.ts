// Uygulamanın üst görünümü. 'mail' dışında liste + okuma bölmesi yerine sayfa render edilir; posta seçimi durur, geri dönünce aynen görünür.
import type { View } from './navigation'

export type AppView = 'mail' | 'calendar' | 'contacts'

/** Geçmiş kaydı: posta görünümünde yok */
export function pimNavView(view: AppView, detail: boolean): View | null {
  if (view === 'mail') return null
  return detail ? 'pimDetail' : 'pim'
}

export const pimDetailOf = (s: { appView: AppView; selectedContactId: number | null; selectedEvent: unknown }): boolean =>
  s.appView === 'contacts' ? s.selectedContactId != null : s.appView === 'calendar' && s.selectedEvent != null
