// Dokunmatik bağlam menüsü: 500 ms basılı tutunca sağ tık işleyicisiyle aynı menü açılır. Parmak
// kayarsa (kaydırma) ya da ikinci parmak gelirse iptal; menü açıldıysa ardından gelen tıklama yutulur.
import { useEffect, useRef, type TouchEvent } from 'react'

export const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 10

export interface LongPress {
  start(x: number, y: number, touches: number): void
  move(x: number, y: number): void
  /** parmak kalktı: uzun basma tetiklendiyse true (türetilen tıklama engellenmeli) */
  end(): boolean
  cancel(): void
}

export function createLongPress(onLongPress: (x: number, y: number) => void): LongPress {
  let timer: ReturnType<typeof setTimeout> | undefined
  let origin: { x: number; y: number } | null = null
  let fired = false
  const cancel = (): void => {
    clearTimeout(timer)
    origin = null
  }
  return {
    start(x, y, touches) {
      fired = false
      cancel()
      if (touches !== 1) return
      origin = { x, y }
      timer = setTimeout(() => {
        if (!origin) return
        fired = true
        origin = null
        onLongPress(x, y)
      }, LONG_PRESS_MS)
    },
    move(x, y) {
      if (origin && (Math.abs(x - origin.x) > MOVE_TOLERANCE || Math.abs(y - origin.y) > MOVE_TOLERANCE)) cancel()
    },
    end() {
      cancel()
      const f = fired
      fired = false
      return f
    },
    cancel
  }
}

/** ignore seçicisine uyan hedefte (düğme, seçilebilir metin) uzun basma başlamaz: yerel davranış kalır */
export function longPressAllowed(target: { closest(sel: string): unknown } | null, ignore?: string): boolean {
  return !ignore || !target?.closest(ignore)
}

/** Satır/bölme için dokunma işleyicileri: onContextMenu'nün yanına yayılır */
export function useLongPress(onLongPress: (x: number, y: number) => void, ignore?: string) {
  const cb = useRef(onLongPress)
  useEffect(() => {
    cb.current = onLongPress
  })
  const ctl = useRef<LongPress | null>(null)
  // denetleyici ilk dokunuşta kurulur (render sırasında ref okunmaz)
  const get = (): LongPress => (ctl.current ??= createLongPress((x, y) => cb.current(x, y)))
  useEffect(() => () => ctl.current?.cancel(), [])
  return {
    onTouchStart(e: TouchEvent) {
      const p = e.touches[0]
      if (!longPressAllowed(e.target as Element, ignore)) return get().cancel()
      get().start(p?.clientX ?? 0, p?.clientY ?? 0, e.touches.length)
    },
    onTouchMove(e: TouchEvent) {
      const p = e.touches[0]
      if (p) get().move(p.clientX, p.clientY)
    },
    onTouchEnd(e: TouchEvent) {
      // menü açıldı: parmak kalkınca türetilen fare olayları (tıklama → ileti açma, dışarı tıklama → menü kapanır) gelmesin
      if (get().end()) e.preventDefault()
    },
    onTouchCancel() {
      get().cancel()
    }
  }
}
