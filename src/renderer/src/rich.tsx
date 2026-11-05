// Çevrilmiş metindeki {ad} yer tutucularını React düğümleriyle doldurur (kalın ad, <code> vb.).
// Metin tek parça çevrilir; vurgulanacak parça yer tutucu olur — cümle dillere göre sıralanabilir.
import { Fragment, type ReactNode } from 'react'

export function rich(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((seg, i) => {
    const m = /^\{(\w+)\}$/.exec(seg)
    return <Fragment key={i}>{m && m[1] in parts ? parts[m[1]] : seg}</Fragment>
  })
}
