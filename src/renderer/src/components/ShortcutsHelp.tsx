import { useStore } from '../store'
import Modal from './Modal'
import { getUiOs, t } from '../../../shared/i18n'
import { platformText } from '../../../shared/platformText'

// klavye kısayolları yardımı — App.tsx global keydown ile birebir eşleşir (? ile açılır).
// Render anında kurulur (dil çalışırken değişebilir). Arama operatörleri Türkçede iki dilli,
// diğer dillerde İngilizce gösterilir; ayrıştırıcı (shared/searchQuery) ikisini de kabul eder.
const keys = (s: string): string => platformText(s, getUiOs())
const groups = (): { title: string; items: [string, string][] }[] => {
  const s = (k: string): [string, string] => [t(`mail.keys.search.${k}`), t(`mail.keys.search.${k}Desc`)]
  return [
    {
      title: t('mail.cmd.section.navigation'),
      items: [['J  ↓', t('mail.keys.nextMail')], ['K  ↑', t('mail.keys.prevMail')], [keys('⌘K'), t('mail.keys.palette')], ['?', t('mail.keys.thisHelp')]]
    },
    {
      title: t('mail.keys.group.triage'),
      items: [
        ['E', t('mail.action.archive')],
        ['#  ⌫', t('action.delete')],
        ['S', t('mail.keys.toggleStar')],
        ['U', t('mail.keys.markUnread')],
        ['⇧I', t('mail.keys.markRead')]
      ]
    },
    {
      title: t('mail.keys.group.compose'),
      items: [
        ['N', t('mail.keys.newMail')],
        ['R', t('mail.action.reply')],
        ['A', t('mail.action.replyAll')],
        ['F', t('mail.action.forward')],
        [keys('⌘↵'), t('mail.keys.send')]
      ]
    },
    {
      title: t('mail.keys.group.search'),
      items: [s('word'), s('phrase'), s('exclude'), s('from'), s('to'), s('subject'), s('account'), s('folder'), s('date'), s('status')]
    },
    {
      title: t('mail.keys.group.general'),
      items: [['Esc', t('mail.keys.closeOrClear')], [keys('⌘,'), t('mail.cmd.settings')], [keys('⇧⌘,'), t('mail.keys.accounts')]]
    }
  ]
}

export default function ShortcutsHelp() {
  const open = useStore((s) => s.shortcutsOpen)
  const setOpen = useStore((s) => s.setShortcutsOpen)
  if (!open) return null
  return (
    <Modal onClose={() => setOpen(false)} className="shortcuts">
        <div className="modal-title">{t('mail.cmd.shortcuts')}</div>
        <div className="shortcut-grid">
          {groups().map((g) => (
            <div key={g.title} className="shortcut-group">
              <div className="sg-title">{g.title}</div>
              {g.items.map(([k, d]) => (
                <div key={k} className="sg-row">
                  <kbd>{k}</kbd>
                  <span>{d}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <span className="hint">{t('mail.keys.hint')}</span>
          <button className="primary" onClick={() => setOpen(false)}>{t('action.close')}</button>
        </div>
    </Modal>
  )
}
