// Sağ tık + dokunmatik uzun basma aynı menüyü açan satır kabı (hesap satırları, ileti satırları)
import type { HTMLAttributes } from 'react'
import { useLongPress } from './useLongPress'

type Props = Omit<HTMLAttributes<HTMLDivElement>, 'onContextMenu'> & { onMenu: (x: number, y: number) => void }

export function LongPressDiv({ onMenu, ...rest }: Props) {
  const lp = useLongPress(onMenu)
  return (
    <div
      {...rest}
      {...lp}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu(e.clientX, e.clientY)
      }}
    />
  )
}
