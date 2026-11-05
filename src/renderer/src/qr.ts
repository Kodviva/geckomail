// 2FA kurulumu için QR kodu: qrcode-generator'ın modül matrisinden kendi SVG'miz (yalnız <svg> + tek <path>).
// Girdi metni çıktıya hiç yazılmaz; sayfaya innerHTML ile değil <img src="data:…"> ile konur.
import qrcode from 'qrcode-generator'

/** Hata düzeltme M, 4 modül sessiz kenar; her koyu modül path'te bir 1×1 kare */
export function qrSvg(text: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const n = qr.getModuleCount()
  const margin = 4
  const size = n + margin * 2
  let d = ''
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) d += `M${c + margin} ${r + margin}h1v1h-1z`
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">` +
    `<path fill="#fff" d="M0 0h${size}v${size}h-${size}z"/><path fill="#000" d="${d}"/></svg>`
  )
}

/** <img src> için; SVG yalnız ASCII olduğundan btoa yeterli */
export const qrDataUri = (text: string): string => `data:image/svg+xml;base64,${btoa(qrSvg(text))}`
