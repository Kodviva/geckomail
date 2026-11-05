import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { applyServerCsp, BASE_CSP, serverCsp } from '../csp'

const directive = (csp: string, name: string): string | undefined =>
  csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `))?.slice(name.length + 1)

describe('çift CSP', () => {
  it('serverCsp connect-src yalnız seçilen sunucuya iner', () => {
    expect(directive(serverCsp('https://posta.example.com'), 'connect-src')).toBe("'self' https://posta.example.com wss://posta.example.com")
    expect(directive(serverCsp('https://posta.example.com:8443'), 'connect-src')).toBe("'self' https://posta.example.com:8443 wss://posta.example.com:8443")
    expect(directive(serverCsp('http://localhost:8080'), 'connect-src')).toBe("'self' http://localhost:8080 ws://localhost:8080")
  })

  it('base has no unsafe-eval', () => {
    expect(BASE_CSP).not.toContain('unsafe-eval')
  })

  it('script-src has no unsafe-inline', () => {
    expect(directive(BASE_CSP, 'script-src')).toBe("'self'")
  })

  it('taban politika planla aynı, index.html meta ile birebir', () => {
    expect(BASE_CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; " +
      "connect-src 'self' https: wss:; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"
    )
    const html = readFileSync(join(__dirname, '../../index.html'), 'utf-8')
    expect(html).toContain(`http-equiv="Content-Security-Policy" content="${BASE_CSP}"`)
  })

  it('applyServerCsp ikinci meta ekler, ilkine dokunmaz', () => {
    const added: Record<string, string>[] = []
    const doc = {
      createElement: () => {
        const el: Record<string, string> = {}
        added.push(el)
        return el
      },
      head: { append: (el: unknown) => expect(added).toContain(el) }
    } as unknown as Document
    applyServerCsp(doc, 'https://posta.example.com')
    expect(added).toEqual([{ httpEquiv: 'Content-Security-Policy', content: serverCsp('https://posta.example.com') }])
  })

  it('bozuk kökenden politika üretilmez', () => {
    for (const bad of ["https://a'; script-src *", 'javascript:alert(1)', 'https://a b']) expect(() => serverCsp(bad), bad).toThrow()
  })
})
