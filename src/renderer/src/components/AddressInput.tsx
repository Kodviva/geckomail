import { useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { t } from '../../../shared/i18n'
import { currentToken, insertContact, matchContacts } from '../addressParse'
import type { Contact } from '../../../shared/rpc'

// Alıcı otomatik-tamamlama: kişi kartları, gruplar ve son kullanılan adresler (store.contacts).
// Virgülle ayrılmış çoklu alıcıyı destekler — caret'in bulunduğu token filtrelenir.
export default function AddressInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  disabled?: boolean
}): React.ReactElement {
  const contacts = useStore((s) => s.contacts)
  const ref = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const matches = useMemo(() => {
    if (!open) return []
    return matchContacts(contacts, currentToken(value, ref.current?.selectionStart ?? value.length), value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, value, contacts])

  const insert = (c: Contact): void => {
    onChange(insertContact(value, ref.current?.selectionStart ?? value.length, c))
    setOpen(false)
    setActive(0)
  }

  return (
    <div className="addr-input">
      <input
        ref={ref}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        // öneri listesi açıkken Esc listeyi kapatır, pencereyi değil (Modal bu işarete bakar)
        data-own-escape={open && matches.length > 0 ? 'true' : undefined}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(0)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (!open || !matches.length) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => (i + 1) % matches.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => (i - 1 + matches.length) % matches.length)
          } else if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault()
            insert(matches[active])
          } else if (e.key === 'Escape') {
            e.stopPropagation() // önce açılır listeyi kapat, composer'ı değil (2. Esc kapatır)
            setOpen(false)
          }
        }}
      />
      {open && matches.length > 0 && (
        <ul className="addr-suggest">
          {matches.map((c, i) => (
            <li
              key={c.groupId != null ? `g${c.groupId}` : c.addr}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                insert(c)
              }}
            >
              <svg className="icon sm addr-suggest-src" aria-hidden="true"><use href={c.groupId != null ? '#i-users' : c.contactId != null ? '#i-user' : '#i-clock'} /></svg>
              <span className="addr-suggest-addr">{c.groupId != null ? t('contacts.group.count', { count: c.members?.length ?? 0 }) : c.addr}</span>
              {c.name && <span className="addr-suggest-name">{c.name}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
