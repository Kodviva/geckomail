// Dar/orta ekran gezinme yığını: 'accounts' (çekmece) | 'list' | 'message' | 'compose' | 'pim' (takvim, kişiler) | 'pimDetail'. Her adım bir
// geçmiş kaydı (History API): tarayıcı/Android geri tuşu uygulamadan çıkmadan bir önceki görünüme döner.
// Durum yalnız history.state'te; URL değişmez.

export type View = 'accounts' | 'list' | 'message' | 'compose' | 'pim' | 'pimDetail'

const KEY = 'gmView'
const BASE = 'gmBase'
const VIEWS: readonly View[] = ['accounts', 'list', 'message', 'compose', 'pim', 'pimDetail']

type NavState = { [KEY]?: unknown; [BASE]?: unknown } | null

function viewOf(state: unknown): View {
  const v = (state as NavState)?.[KEY]
  return VIEWS.includes(v as View) ? (v as View) : 'list'
}

/** Geçmişin şu anki kaydının görünümü (kaydı olmayan ilk sayfa = liste) */
export function currentView(): View {
  return viewOf(window.history.state)
}

export function pushView(v: View): void {
  if (currentView() === v) return // aynı görünüm iki kayıt olursa geri tuşu "hiçbir şey yapmıyor" gibi görünür
  window.history.pushState({ [KEY]: v }, '')
}

export function goBack(): void {
  window.history.back()
}

/** Geri/ileri ile görünüm değişince çağrılır; dönüş aboneliği kaldırır */
export function onBack(cb: (v: View) => void): () => void {
  const h = (e: Event): void => cb(viewOf((e as PopStateEvent).state))
  window.addEventListener('popstate', h)
  return () => window.removeEventListener('popstate', h)
}

/** Dar ekran kökü: hesaplar ← liste. Listeden geri tuşu önce çekmeceyi açar; ilk açılışta bir kez */
export function ensureNarrowBase(): void {
  if ((window.history.state as NavState)?.[KEY] != null) return
  window.history.replaceState({ [KEY]: 'accounts', [BASE]: true }, '')
  window.history.pushState({ [KEY]: 'list' }, '')
}

/** Çekmeceyi kapatan geçmiş adımı: itilmiş kayıttaysa geri; kökteyse (geri uygulamayı kapatır) listeye ileri */
export function closeDrawerEntry(back: () => void = goBack): void {
  if (currentView() !== 'accounts') return
  if ((window.history.state as NavState)?.[BASE]) window.history.pushState({ [KEY]: 'list' }, '')
  else back()
}
