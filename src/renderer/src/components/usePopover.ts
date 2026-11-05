import { useEffect, useRef, useState } from 'react'

// Açılır menülerin ortak davranışı: dışarı tıklayınca ve Esc ile kapanır; Esc'te odak tetikleyiciye döner.
// ref, tetikleyici düğmeyi ve menüyü birlikte saran kapsayıcıya (.menu-anchor) verilir.
export function usePopover<T extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false)
  const ref = useRef<T>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation() // genel Esc işleyicisi (seçimi temizleme vb.) tetiklenmesin
      setOpen(false)
      ref.current?.querySelector<HTMLElement>('[aria-haspopup]')?.focus()
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return { open, setOpen, ref, toggle: () => setOpen((v) => !v) }
}
