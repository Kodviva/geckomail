import { useStore } from '../store'
import { t } from '../../../shared/i18n'

// Kayıtlı aramalar: mevcut arama sorgusunu adlandırıp kaydet, tek tıkla yeniden çalıştır.
// 67 izleme kutusu için pratik (örn. `from:noreply@veeam` ya da bir konu filtresi). localStorage tabanlı.
export default function SavedSearches() {
  const savedSearches = useStore((s) => s.savedSearches)
  const searchQuery = useStore((s) => s.searchQuery)
  const applySavedSearch = useStore((s) => s.applySavedSearch)
  const deleteSavedSearch = useStore((s) => s.deleteSavedSearch)
  const saveCurrentSearch = useStore((s) => s.saveCurrentSearch)

  const canSave = searchQuery.trim().length > 0
  if (savedSearches.length === 0 && !canSave) return null

  const onSave = (): void => {
    const name = window.prompt(t('mail.saved.namePrompt'))
    if (name && name.trim()) saveCurrentSearch(name.trim())
  }

  // Süzgeç çiplerinin yanında aynı satırda (ListPane .chip-row) — ayrı satır açmaz
  return (
    <>
      <span className="chip-sep" aria-hidden="true" />
      {savedSearches.map((s) => (
        <button key={s.name} type="button" className="chip saved-chip" title={s.query} onClick={() => applySavedSearch(s.query)}>
          <svg className="icon xs"><use href="#i-search" /></svg>
          <span className="saved-chip-name">{s.name}</span>
          <span
            className="saved-chip-x"
            title={t('action.delete')}
            onClick={(e) => {
              e.stopPropagation()
              deleteSavedSearch(s.name)
            }}
          >
            <svg className="icon xs"><use href="#i-x" /></svg>
          </span>
        </button>
      ))}
      {canSave && (
        <button type="button" className="chip saved-add" onClick={onSave} title={t('mail.saved.saveTitle')}>
          <svg className="icon xs"><use href="#i-plus" /></svg>
          {t('mail.saved.save')}
        </button>
      )}
    </>
  )
}
