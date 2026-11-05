// Duyarlı yerleşim kırılımları: geniş = bugünkü üç bölme, orta = kenar çubuğu çekmece, dar = tek bölme.
// Değerler styles.css'teki @media (max-width: 1199px / 767px) bloklarıyla aynı olmalı.
import { useSyncExternalStore } from 'react'
import type { PlatformKind } from '../platform'

export type Breakpoint = 'wide' | 'medium' | 'narrow' // ≥1200 | 768–1199 | <768

export const WIDE_MIN = 1200
export const MEDIUM_MIN = 768

export function breakpointFor(width: number): Breakpoint {
  if (width >= WIDE_MIN) return 'wide'
  if (width >= MEDIUM_MIN) return 'medium'
  return 'narrow'
}

/** Gezinmenin kullandığı kırılım: orta/dar yerleşim yalnız web'de, oturum açıkken. Electron her
 *  genişlikte bugünkü üç bölmede kalır */
export function navBreakpoint(width: Breakpoint, kind: PlatformKind, active: boolean): Breakpoint {
  return active && kind === 'web' ? width : 'wide'
}

// matchMedia CSS ile aynı ölçüyü kullanır (innerWidth kaydırma çubuğunu da sayar, CSS saymaz)
const NARROW_Q = `(max-width: ${MEDIUM_MIN - 1}px)`
const MEDIUM_Q = `(max-width: ${WIDE_MIN - 1}px)`

function current(): Breakpoint {
  if (typeof window === 'undefined' || !window.matchMedia) return 'wide'
  if (window.matchMedia(NARROW_Q).matches) return 'narrow'
  if (window.matchMedia(MEDIUM_Q).matches) return 'medium'
  return 'wide'
}

function subscribe(cb: () => void): () => void {
  const qs = [window.matchMedia(NARROW_Q), window.matchMedia(MEDIUM_Q)]
  qs.forEach((q) => q.addEventListener('change', cb))
  return () => qs.forEach((q) => q.removeEventListener('change', cb))
}

export function useBreakpoint(): Breakpoint {
  return useSyncExternalStore(subscribe, current, () => 'wide')
}
