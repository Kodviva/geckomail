import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { breakpointFor, navBreakpoint } from '../layout/useBreakpoint'
import { pimNavView } from '../layout/appView'
import { closeDrawerEntry, currentView, ensureNarrowBase, goBack, onBack, pushView, type View } from '../layout/navigation'

/** Tarayıcı geçmişinin küçük taklidi: back() bir önceki kaydın durumuyla popstate yayar (eşzamanlı) */
function fakeWindow(): { entries: unknown[]; index: () => number } {
  const target = new EventTarget()
  const entries: unknown[] = [null]
  let i = 0
  const history = {
    get state() {
      return entries[i]
    },
    pushState(s: unknown) {
      entries.splice(i + 1)
      entries.push(s)
      i++
    },
    replaceState(s: unknown) {
      entries[i] = s
    },
    back() {
      if (i === 0) return
      i--
      const e = new Event('popstate') as Event & { state: unknown }
      e.state = entries[i]
      target.dispatchEvent(e)
    }
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    history,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target)
  }
  return { entries, index: () => i }
}

describe('kırılım noktaları', () => {
  it('geniş ≥1200, orta 768–1199, dar <768', () => {
    expect(breakpointFor(1440)).toBe('wide')
    expect(breakpointFor(1200)).toBe('wide')
    expect(breakpointFor(1199)).toBe('medium')
    expect(breakpointFor(1024)).toBe('medium')
    expect(breakpointFor(768)).toBe('medium')
    expect(breakpointFor(767)).toBe('narrow')
    expect(breakpointFor(390)).toBe('narrow')
  })
})

describe('gezinme kırılımı', () => {
  it('yalnız web ve oturum açıkken; Electron her genişlikte üç bölme', () => {
    expect(navBreakpoint('narrow', 'web', true)).toBe('narrow')
    expect(navBreakpoint('medium', 'web', true)).toBe('medium')
    expect(navBreakpoint('narrow', 'web', false)).toBe('wide')
    expect(navBreakpoint('medium', 'electron', true)).toBe('wide')
    expect(navBreakpoint('narrow', 'electron', true)).toBe('wide')
  })
})

describe('dar ekran gezinme (History API)', () => {
  let h: ReturnType<typeof fakeWindow>
  beforeEach(() => {
    h = fakeWindow()
  })
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it('ileti açılınca geri tuşu listeye döner', () => {
    const seen: View[] = []
    const off = onBack((v) => seen.push(v))
    pushView('message')
    expect(currentView()).toBe('message')
    goBack()
    expect(seen).toEqual(['list'])
    expect(currentView()).toBe('list')
    off()
  })

  it('aynı görünüm ikinci kez itilmez (geri tek adımda döner)', () => {
    pushView('message')
    pushView('message')
    expect(h.entries).toHaveLength(2)
  })

  it('oluşturucudan geri iletiye, ondan listeye', () => {
    const seen: View[] = []
    const off = onBack((v) => seen.push(v))
    pushView('message')
    pushView('compose')
    goBack()
    goBack()
    expect(seen).toEqual(['message', 'list'])
    off()
  })

  it('dar kök: listeden geri hesaplar çekmecesini açar, uygulamadan çıkmaz', () => {
    ensureNarrowBase()
    ensureNarrowBase() // ikinci çağrı yeni kayıt eklemez
    expect(h.entries).toHaveLength(2)
    const seen: View[] = []
    const off = onBack((v) => seen.push(v))
    pushView('message')
    goBack()
    goBack()
    expect(seen).toEqual(['list', 'accounts'])
    off()
  })

  it('çekmece kapatma: itilmiş kayıtta geri, kökte listeye ileri', () => {
    const seen: View[] = []
    const off = onBack((v) => seen.push(v))
    pushView('accounts')
    closeDrawerEntry()
    expect(seen).toEqual(['list'])
    expect(currentView()).toBe('list')

    ensureNarrowBase()
    goBack() // köke: çekmece
    expect(currentView()).toBe('accounts')
    closeDrawerEntry() // kökten geri gidilmez (uygulama kapanırdı): listeye itilir
    expect(currentView()).toBe('list')
    off()
  })

  it('aboneliği kaldırınca geri bildirimi gelmez', () => {
    const seen: View[] = []
    const off = onBack((v) => seen.push(v))
    off()
    pushView('message')
    goBack()
    expect(seen).toEqual([])
  })
})

describe('kişi ve takvim gezinmesi', () => {
  it('back from pimDetail returns to list', () => {
    fakeWindow()
    const seen: View[] = []
    const off = onBack((v) => seen.push(v))
    ensureNarrowBase()
    pushView('pim')
    pushView('pimDetail')
    goBack()
    expect(seen).toEqual(['pim'])
    expect(currentView()).toBe('pim')
    goBack()
    expect(seen).toEqual(['pim', 'list'])
    off()
  })

  it('görünüm ve seçim kaydı belirler', () => {
    expect(pimNavView('mail', false)).toBeNull()
    expect(pimNavView('contacts', false)).toBe('pim')
    expect(pimNavView('calendar', true)).toBe('pimDetail')
  })
})
