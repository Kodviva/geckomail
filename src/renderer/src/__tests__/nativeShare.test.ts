import { readFileSync } from 'fs'
import { resolve } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => {
  let state: Record<string, unknown> = {}
  return { useStore: { getState: () => state, setState: (p: Record<string, unknown>) => { state = { ...state, ...p } } } }
})
vi.mock('../store', () => store)

import { drainPending, mergeShares, shareToComposer } from '../nativeShare'
import type { GeckoNativePlugin, NativeShare } from '../platform/nativeBridge'

const { useStore } = store as unknown as { useStore: { getState(): { composer?: { text: string } | null }; setState(p: object): void } }

const file = (name: string, n = 1): NativeShare['files'][number] => ({ name, uploadPath: `/_capacitor_file_/x/${n}`, mime: 'application/pdf' })

describe('paylaşım', () => {
  const addAttachments = vi.fn(async () => {})
  const toast = vi.fn()
  const openComposer = vi.fn(() => useStore.setState({ composer: { text: '-- imza', attachments: [] } }))
  const body = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useStore.setState({ composer: null, addAttachments, toast, openComposer })
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      body(u)
      return new Response(new Blob(['veri']), { status: 200 })
    }))
  })

  it('dosyalar yerel yoldan okunur, oluşturucu ekle yüklenir', async () => {
    await shareToComposer({ files: [file('rapor.pdf')], text: null })
    expect(openComposer).toHaveBeenCalledWith('new')
    expect(body).toHaveBeenCalledWith('/_capacitor_file_/x/1')
    const [files] = addAttachments.mock.calls[0] as unknown as [File[]]
    expect(files.map((f) => [f.name, f.type])).toEqual([['rapor.pdf', 'application/pdf']])
  })

  it('metin gövdenin başına, imzanın üstüne gelir', async () => {
    await shareToComposer({ files: [], text: 'bakınız' })
    expect(useStore.getState().composer?.text).toBe('bakınız\n\n-- imza')
    expect(addAttachments).not.toHaveBeenCalled()
  })

  it('oversized share warns', async () => {
    await shareToComposer({ files: [file('a.pdf')], text: null, skipped: 2 })
    expect(toast).toHaveBeenCalledTimes(1)
    expect(addAttachments).toHaveBeenCalledTimes(1)
  })

  it('izinli yol dışındaki adres okunmaz', async () => {
    await shareToComposer({ files: [{ name: 'x', uploadPath: 'https://evil.example/x' }], text: null })
    expect(body).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
  })

  it('okunamayan dosya uyarır, kalanlar eklenir', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => new Response(new Blob(['v']), { status: u.endsWith('2') ? 404 : 200 })))
    await shareToComposer({ files: [file('a', 1), file('b', 2)], text: null })
    expect(toast).toHaveBeenCalledTimes(1)
    const [files] = addAttachments.mock.calls[0] as unknown as [File[]]
    expect(files.map((f) => f.name)).toEqual(['a'])
  })

  it('birden çok paylaşım tek oluşturucuda birleşir', () => {
    expect(mergeShares([{ files: [file('a')], text: 'x' }, { files: [file('b')], text: 'y', skipped: 1 }])).toEqual({
      files: [file('a'), file('b')], text: 'x\ny', skipped: 1
    })
    expect(mergeShares([])).toBeNull()
  })

  it('boşaltma: açmalar sonra paylaşım, sonunda yerel dosyalar bırakılır', async () => {
    const sharesDone = vi.fn(async () => {})
    const plugin = { takePending: async () => ({ opens: [{ messageId: 1, accountId: null, reply: false }], shares: [{ files: [file('a')], text: null }] }), sharesDone } as unknown as GeckoNativePlugin
    const open = vi.fn()
    await drainPending(plugin, open)
    expect(open).toHaveBeenCalledTimes(1)
    expect(addAttachments).toHaveBeenCalledTimes(1)
    expect(sharesDone).toHaveBeenCalledTimes(1)
  })

  it('paylaşım yoksa yerel katman çağrılmaz', async () => {
    const sharesDone = vi.fn(async () => {})
    await drainPending({ takePending: async () => ({ opens: [], shares: [] }), sharesDone } as unknown as GeckoNativePlugin, vi.fn())
    expect(sharesDone).not.toHaveBeenCalled()
    expect(openComposer).not.toHaveBeenCalled()
  })

  it('hesap yoksa oluşturucu açılmaz, dosyalar okunmaz', async () => {
    openComposer.mockImplementationOnce(() => useStore.setState({ composer: null }))
    await shareToComposer({ files: [file('a')], text: null })
    expect(body).not.toHaveBeenCalled()
  })
})

describe('iOS paylaşım eklentisi', () => {
  it('share extension uses no private selector to open the app', () => {
    const src = readFileSync(resolve(process.cwd(), 'mobile/ios/ShareExtension/ShareViewController.swift'), 'utf-8')
    expect(src).not.toMatch(/NSSelectorFromString|openURL|unsafeBitCast|geckomail:\/\//)
    expect(src).toContain('mobile.share.openApp')
  })
})
