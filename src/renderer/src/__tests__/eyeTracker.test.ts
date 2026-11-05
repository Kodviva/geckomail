import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// jsdom eklemeden: tracker'ın dokunduğu minimum DOM'u elle taklit et, mousemove'u
// yakalanan dinleyiciyle tetikle, sahte rAF'ı çalıştır, bebeğin cx/cy'sini oku.
// Böylece tüm zincir (querySelectorAll → kayıt → dinleyici → frame → setAttribute) test edilir.

interface FakeCircle {
  getAttribute: (k: string) => string | null
  setAttribute: (k: string, v: string) => void
}

function circle(attrs: Record<string, number>): FakeCircle {
  const a: Record<string, number> = { ...attrs }
  return {
    getAttribute: (k: string) => (k in a ? String(a[k]) : null),
    setAttribute: (k: string, v: string) => {
      a[k] = parseFloat(v)
    }
  }
}

function eyeSvg(rect: { left: number; top: number; width: number; height: number }) {
  const ring = circle({ cx: 5, cy: 5, r: 4.2 })
  const pupil = circle({ cx: 5.8, cy: 4.2, r: 1.5 })
  return {
    _pupil: pupil,
    viewBox: { baseVal: { width: 10, height: 10 } },
    getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }),
    querySelectorAll: (sel: string) => (sel === 'circle' ? [ring, pupil] : [])
  }
}

let moveHandler: ((e: { clientX: number; clientY: number }) => void) | null

function installFakeDom(eye: ReturnType<typeof eyeSvg>): void {
  let n = 0
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    if (n++ < 120) cb(performance.now()) // frame kendini çağırır → sınırla; ease yakınsasın diye bol kare
    return 0
  })
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: (e: { clientX: number; clientY: number }) => void) => {
      if (type === 'mousemove') moveHandler = fn
    },
    matchMedia: () => ({ matches: false })
  })
  vi.stubGlobal('document', {
    documentElement: { classList: { toggle: () => {} } },
    querySelectorAll: (sel: string) => (sel === 'svg.eye' ? [eye] : [])
  })
}

describe('eyeTracker — fare takibi', () => {
  beforeEach(() => {
    moveHandler = null
    vi.resetModules()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('fare sağ-altta iken bebeği oraya çevirir, halkanın içinde kalır', async () => {
    const eye = eyeSvg({ left: 100, top: 100, width: 20, height: 20 }) // göz merkezi ekranda (110,110)
    installFakeDom(eye)
    const { startEyeTracker } = await import('../eyeTracker')
    startEyeTracker()
    expect(moveHandler).toBeTypeOf('function') // dinleyici gerçekten bağlandı mı
    moveHandler!({ clientX: 400, clientY: 400 }) // merkezin sağ-altı → onMove → frame

    const cx = parseFloat(eye._pupil.getAttribute('cx') ?? 'NaN')
    const cy = parseFloat(eye._pupil.getAttribute('cy') ?? 'NaN')
    expect(cx).toBeGreaterThan(5)
    expect(cy).toBeGreaterThan(5)
    expect(Math.hypot(cx - 5, cy - 5)).toBeLessThan(2.7) // halka(4.2)−bebek(1.5): asla taşmaz
  })

  it('fare sol-üstte iken bebeği ters yöne çevirir', async () => {
    const eye = eyeSvg({ left: 100, top: 100, width: 20, height: 20 })
    installFakeDom(eye)
    const { startEyeTracker } = await import('../eyeTracker')
    startEyeTracker()
    moveHandler!({ clientX: 0, clientY: 0 })

    expect(parseFloat(eye._pupil.getAttribute('cx') ?? 'NaN')).toBeLessThan(5)
    expect(parseFloat(eye._pupil.getAttribute('cy') ?? 'NaN')).toBeLessThan(5)
  })
})
