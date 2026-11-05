// Bağlam menüleri için klavye gezintisi ve ARIA (UX-P2-12). Menü öğeleri .ctx-item div'leri;
// açılışta role=menuitem + tabindex verilir, ok tuşları/Home/End ile gezilir, Enter/Boşluk tıklar.
import type { KeyboardEvent } from 'react'

const items = (menu: HTMLElement): HTMLElement[] =>
  [...menu.querySelectorAll<HTMLElement>('.ctx-item')].filter((el) => !el.classList.contains('disabled') && el.offsetParent !== null)

export function decorateMenu(menu: HTMLElement | null): void {
  if (!menu) return
  menu.setAttribute('role', 'menu')
  for (const el of menu.querySelectorAll<HTMLElement>('.ctx-item')) {
    el.setAttribute('role', 'menuitem')
    el.tabIndex = -1
  }
  for (const el of menu.querySelectorAll<HTMLElement>('.ctx-divider')) el.setAttribute('role', 'separator')
}

/** true dönerse tuş işlendi (çağıran başka bir şey yapmasın) */
export function menuKeyNav(e: KeyboardEvent<HTMLElement>, menu: HTMLElement | null): boolean {
  if (!menu) return false
  const list = items(menu)
  if (!list.length) return false
  const i = list.indexOf(document.activeElement as HTMLElement)
  let next: HTMLElement | null = null
  if (e.key === 'ArrowDown') next = list[(i + 1) % list.length]
  else if (e.key === 'ArrowUp') next = list[(i - 1 + list.length) % list.length]
  else if (e.key === 'Home') next = list[0]
  else if (e.key === 'End') next = list[list.length - 1]
  else if ((e.key === 'Enter' || e.key === ' ') && i >= 0) {
    e.preventDefault()
    list[i].click()
    return true
  }
  if (!next) return false
  e.preventDefault()
  // sonradan açılan alt menü öğeleri dekore edilmemiş olabilir
  if (!next.hasAttribute('tabindex')) next.tabIndex = -1
  next.setAttribute('role', 'menuitem')
  next.focus()
  return true
}
