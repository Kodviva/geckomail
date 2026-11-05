// Tüm pencerelerin ortak kabuğu (UX-P1-10, P1-6): dialog rolleri, Esc ile en üstteki pencereyi kapatma,
// odak tuzağı + açılışta odak + kapanınca odağı geri verme, kaplamaya tıklayınca kapatma ve
// (confirmOnDirty) kaydedilmemiş değişiklikte onay. Önceden 20 bileşen kaplamayı elle kuruyordu;
// Esc hiçbirini kapatmıyordu, ekran okuyucu pencereyi pencere olarak tanımıyordu.
import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { t } from '../../../shared/i18n'

// açık pencere yığını: Esc/Tab yalnız en üsttekine
const stack: string[] = []

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

export interface ModalProps {
  onClose: () => void
  className?: string
  children: ReactNode
  /** kaplamaya tıklayınca kapansın mı (içe aktarma sihirbazı gibi uzun işlerde kapalı) */
  closeOnBackdrop?: boolean
  /** düzenleme formları: içeride bir alan değiştiyse Esc/kaplama kapatmadan önce sor */
  confirmOnDirty?: boolean
  onKeyDown?: (e: KeyboardEvent<HTMLDivElement>) => void
}

export default function Modal({ onClose, className = '', children, closeOnBackdrop = true, confirmOnDirty = false, onKeyDown }: ModalProps) {
  const id = useId()
  const ref = useRef<HTMLDivElement>(null)
  const dirty = useRef(false)
  const attemptClose = (): void => {
    if (confirmOnDirty && dirty.current && !window.confirm(t('mail.modal.discardChanges'))) return
    onClose()
  }
  // belge düzeyindeki Esc dinleyicisi her zaman en güncel kapatma işlevini çağırsın (dinleyici bir kez kurulur)
  const attemptCloseRef = useRef(attemptClose)
  useLayoutEffect(() => {
    attemptCloseRef.current = attemptClose
  })

  useEffect(() => {
    stack.push(id)
    const previouslyFocused = document.activeElement as HTMLElement | null
    const el = ref.current!
    // başlık → aria-labelledby
    const title = el.querySelector<HTMLElement>('.modal-title')
    if (title) {
      if (!title.id) title.id = `${id}-title`
      el.setAttribute('aria-labelledby', title.id)
    }
    // açılışta odak: autoFocus'lu alan zaten odaktaysa dokunma; değilse ilk odaklanabilir öğe
    queueMicrotask(() => {
      if (!el.contains(document.activeElement)) {
        const first = el.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ?? el.querySelector<HTMLElement>(FOCUSABLE)
        ;(first ?? el).focus()
      }
    })
    const markDirty = () => (dirty.current = true)
    el.addEventListener('input', markDirty)
    el.addEventListener('change', markDirty)

    const onDocKey = (e: globalThis.KeyboardEvent): void => {
      if (stack[stack.length - 1] !== id) return
      if (e.key === 'Escape') {
        // açık bir alt öğe (öneri listesi vb.) Esc'i kendisi yönetiyor: önce o kapansın
        if ((e.target as HTMLElement | null)?.closest?.('[data-own-escape="true"]')) return
        e.preventDefault()
        e.stopPropagation()
        attemptCloseRef.current()
        return
      }
      if (e.key === 'Tab') {
        const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null)
        if (!items.length) return
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        } else if (!el.contains(document.activeElement)) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', onDocKey, true)
    return () => {
      document.removeEventListener('keydown', onDocKey, true)
      el.removeEventListener('input', markDirty)
      el.removeEventListener('change', markDirty)
      const i = stack.lastIndexOf(id)
      if (i >= 0) stack.splice(i, 1)
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus()
    }
  }, [id])

  return (
    <div className="overlay" onMouseDown={(e) => closeOnBackdrop && e.target === e.currentTarget && attemptClose()}>
      <div ref={ref} className={`modal ${className}`.trim()} role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={onKeyDown}>
        {children}
      </div>
    </div>
  )
}

/** Test/ekran dışı yardımcı: açık pencere var mı (genel kısayollar için) */
export function anyModalOpen(): boolean {
  return stack.length > 0
}
