import { describe, expect, it } from 'vitest'
import { qrSvg, qrDataUri } from '../qr'

const URI = 'otpauth://totp/GeckoMail:ayse?secret=JBSWY3DPEHPK3PXP&issuer=GeckoMail&algorithm=SHA1&digits=6&period=30'

describe('qrSvg', () => {
  it('aynı girdi aynı SVG', () => {
    expect(qrSvg(URI)).toBe(qrSvg(URI))
    expect(qrSvg(URI)).not.toBe(qrSvg(URI + 'x'))
  })

  it('yalnız <svg> ve <path>: betik, olay özniteliği ya da dış kaynak yok', () => {
    const s = qrSvg(URI)
    expect(s.startsWith('<svg')).toBe(true)
    expect(s.endsWith('</svg>')).toBe(true)
    expect(s).not.toMatch(/<script/i)
    expect(s).not.toMatch(/\son\w+=/i)
    expect(s).not.toMatch(/href/i)
    const tags = [...s.matchAll(/<\/?([a-zA-Z]+)/g)].map((m) => m[1])
    expect(new Set(tags)).toEqual(new Set(['svg', 'path']))
  })

  it('girdideki işaretleme çıktıya sızmaz', () => {
    const s = qrSvg('"><script>alert(1)</script>')
    expect(s).not.toMatch(/script|alert/i)
  })

  it('img için data: URI (base64)', () => {
    const d = qrDataUri(URI)
    expect(d.startsWith('data:image/svg+xml;base64,')).toBe(true)
    expect(atob(d.slice('data:image/svg+xml;base64,'.length))).toBe(qrSvg(URI))
  })
})
