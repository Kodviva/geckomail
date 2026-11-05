import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acceptInstall, dismissInstall, installAvailable, isPromptAllowed, PROMPT_KEY, registerServiceWorker, startInstallPrompt
} from '../pwa'

const DAY = 86_400_000

describe('yükleme önerisi', () => {
  it('kayıt yoksa ya da erteleme bittiyse izinli', () => {
    expect(isPromptAllowed(null, 1000)).toBe(true)
    expect(isPromptAllowed('999', 1000)).toBe(true)
    expect(isPromptAllowed('bozuk', 1000)).toBe(true)
  })

  it('ertelenmişken ve "bir daha sorma"da izinsiz', () => {
    expect(isPromptAllowed('2000', 1000)).toBe(false)
    expect(isPromptAllowed('never', 1000)).toBe(false)
  })

  describe('olay akışı', () => {
    let store: Map<string, string>
    let fire: (e: Event) => void
    let stop: () => void

    function promptEvent(outcome = 'accepted') {
      const e = new Event('beforeinstallprompt') as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> }
      e.prompt = vi.fn(async () => {})
      e.userChoice = Promise.resolve({ outcome })
      return e
    }

    beforeEach(() => {
      store = new Map()
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v)
      })
      const listeners = new Map<string, (e: Event) => void>()
      vi.stubGlobal('window', {
        addEventListener: (n: string, cb: (e: Event) => void) => listeners.set(n, cb),
        removeEventListener: (n: string) => listeners.delete(n)
      })
      stop = startInstallPrompt()
      fire = (e) => listeners.get(e.type)?.(e)
    })
    afterEach(() => {
      stop()
      vi.unstubAllGlobals()
      vi.useRealTimers()
    })

    it('olay gelince yerleşik öneri bastırılır, öneri açılır', () => {
      expect(installAvailable()).toBe(false)
      const e = promptEvent()
      const pd = vi.spyOn(e, 'preventDefault')
      fire(e)
      expect(pd).toHaveBeenCalled()
      expect(installAvailable()).toBe(true)
    })

    it('"Şimdi değil" bir hafta erteler', () => {
      vi.useFakeTimers({ now: 1_000_000 })
      fire(promptEvent())
      dismissInstall('later')
      expect(installAvailable()).toBe(false)
      expect(store.get(PROMPT_KEY)).toBe(String(1_000_000 + 7 * DAY))
      // hafta dolmadan gelen olay öneri açmaz
      fire(promptEvent())
      expect(installAvailable()).toBe(false)
      vi.setSystemTime(1_000_000 + 7 * DAY + 1)
      fire(promptEvent())
      expect(installAvailable()).toBe(true)
    })

    it('"Bir daha sorma" kalıcı', () => {
      fire(promptEvent())
      dismissInstall('never')
      expect(store.get(PROMPT_KEY)).toBe('never')
      fire(promptEvent())
      expect(installAvailable()).toBe(false)
    })

    it('kabul: tarayıcı sorusu açılır; reddedilirse bir hafta sorulmaz', async () => {
      const e = promptEvent('dismissed')
      fire(e)
      await acceptInstall()
      expect(e.prompt).toHaveBeenCalled()
      expect(installAvailable()).toBe(false)
      expect(Number(store.get(PROMPT_KEY))).toBeGreaterThan(Date.now())
    })

    it('tarayıcı soruyu açamazsa hata yutulur, bir hafta sorulmaz', async () => {
      const e = promptEvent()
      e.prompt = vi.fn(async () => {
        throw new Error('NotAllowedError')
      })
      fire(e)
      await expect(acceptInstall()).resolves.toBeUndefined()
      expect(installAvailable()).toBe(false)
      expect(Number(store.get(PROMPT_KEY))).toBeGreaterThan(Date.now())
    })

    it('localStorage çalışmıyorsa öneri yine kapanır', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => { throw new Error('engelli') },
        setItem: () => { throw new Error('engelli') }
      })
      fire(promptEvent())
      expect(installAvailable()).toBe(true)
      dismissInstall('later')
      expect(installAvailable()).toBe(false)
    })
  })
})

describe('service worker kaydı', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('destek yoksa sessiz', () => {
    vi.stubGlobal('navigator', {})
    expect(() => registerServiceWorker()).not.toThrow()
  })

  it('/sw.js kök kapsamla kaydolur; hata yutulur', async () => {
    const register = vi.fn(async () => { throw new Error('güvensiz köken') })
    vi.stubGlobal('navigator', { serviceWorker: { register } })
    registerServiceWorker()
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' })
    await new Promise((r) => setTimeout(r, 0))
  })
})
