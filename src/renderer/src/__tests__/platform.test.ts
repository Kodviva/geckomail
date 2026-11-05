import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '../../../shared/i18n'

// Ekler Electron'da sync'in getAttachment RPC'siyle diske iner; burada yalnız iletim denetlenir
vi.mock('../rpcClient', () => ({
  rpc: { call: vi.fn(async () => ({ diskPath: '/tmp/ek.pdf' })) }
}))

type W = Record<string, unknown>
const g = globalThis as unknown as { window?: W }

async function load(win: W): Promise<typeof import('../platform')> {
  g.window = win
  vi.resetModules()
  return import('../platform')
}

describe('platform adaptörü', () => {
  beforeEach(() => {
    delete g.window
  })
  afterEach(() => {
    delete g.window
  })

  it('web: dil bağlantı açıksa oturuma bildirilir, kapalıysa kuyruğa girmez', async () => {
    const { platform } = await load({})
    const { rpc } = (await import('../rpcClient')) as unknown as { rpc: { call: ReturnType<typeof vi.fn>; isOpen?: boolean } }
    rpc.call.mockClear()
    platform.setLocale('en')
    expect(rpc.call).not.toHaveBeenCalled()
    rpc.isOpen = true
    platform.setLocale('en')
    expect(rpc.call).toHaveBeenCalledWith('setSessionLocale', { locale: 'en' })
  })

  it('window.gecko yokken web', async () => {
    const { platform } = await load({})
    expect(platform.kind).toBe('web')
    expect(platform.savedLocale()).toBeNull()
    expect(platform.wallboard).toBeNull()
    expect(platform.filePath({} as File)).toBeNull()
    expect(await platform.trashFile('/x')).toBe(false)
    expect(await platform.chooseBackupSave('a.geckobak', true)).toBeNull()
    expect(await platform.chooseBackupOpen()).toBeNull()
    expect(await platform.biometricAvailable()).toBe(false)
    expect(await platform.promptBiometric('?')).toBe(false)
    expect(() => platform.setLocale('en')).not.toThrow()
  })

  it('web: ek indirme bağlantısı ve dosya yükleme HTTP ile', async () => {
    const clicked: { href: string; download: string }[] = []
    const document = {
      createElement: () => {
        const a = { href: '', download: '', rel: '', style: {} as Record<string, string>, click: () => clicked.push({ href: a.href, download: a.download }), remove: () => {} }
        return a
      },
      body: { appendChild: () => {} }
    }
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async (): Promise<unknown> => ({ uploadId: 'ab'.repeat(16) }) }))
    const mod = await load({})
    const { platform } = mod
    vi.stubGlobal('document', document)
    vi.stubGlobal('fetch', fetch)
    try {
      await platform.openAttachment({ messageId: 7, attachmentId: 3, name: 'ek.pdf' })
      expect(fetch).toHaveBeenLastCalledWith('/api/attachment/7/3', { method: 'HEAD', credentials: 'same-origin' })
      expect(clicked).toEqual([{ href: '/api/attachment/7/3', download: 'ek.pdf' }])

      // indirme başlamadan hata görünür: kilitli kasa, IMAP hatası, düşen oturum
      clicked.length = 0
      for (const [status, text] of [[423, t('mail.list.vaultLocked')], [502, t('sync.body.downloadFailed')], [401, t('acct.session.expired')], [404, '404']] as const) {
        fetch.mockResolvedValueOnce({ ok: false, status, json: async () => ({}) })
        await expect(platform.openAttachment({ messageId: 7, attachmentId: 3, name: 'ek.pdf' })).rejects.toThrow(text)
      }
      fetch.mockRejectedValueOnce(new Error('ağ yok'))
      await expect(platform.revealAttachment({ messageId: 7, attachmentId: 3, name: 'ek.pdf' })).rejects.toThrow('ağ yok')
      expect(clicked).toEqual([])

      expect(platform.uploadFile).not.toBeNull()
      const file = new Blob(['merhaba']) as File
      Object.defineProperty(file, 'name', { value: "öz (1)'.pdf" })
      expect(await platform.uploadFile!(file)).toBe('ab'.repeat(16))
      expect(fetch).toHaveBeenCalledWith('/api/upload', {
        method: 'POST', credentials: 'same-origin', body: file,
        headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': "UTF-8''%C3%B6z%20%281%29%27.pdf" }
      })
      fetch.mockResolvedValueOnce({ ok: false, status: 413, json: async () => ({ reason: 'tooLarge' }) })
      const err = await platform.uploadFile!(file).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(mod.UploadError)
      expect(err).toMatchObject({ status: 413 })
      // vazgeçilen yükleme sunucuda silinir; ağ hatası yutulur
      await platform.discardUpload!('cd'.repeat(16))
      expect(fetch).toHaveBeenLastCalledWith(`/api/upload/${'cd'.repeat(16)}`, { method: 'DELETE', credentials: 'same-origin' })
      fetch.mockRejectedValueOnce(new Error('ağ yok'))
      await expect(platform.discardUpload!('cd'.repeat(16))).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('web: yedek indirme sunucunun geri yüklenemez işaretini bildirir', async () => {
    const { platform } = await load({})
    const res = (restorable: string | null) => ({
      ok: true, status: 200, blob: async () => new Blob(['x']),
      headers: { get: (k: string) => (k === 'X-Gecko-Restorable' ? restorable : null) }
    })
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} })
    vi.stubGlobal('document', { createElement: () => ({ style: {}, click: () => {}, remove: () => {} }), body: { appendChild: () => {} } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(res('0')).mockResolvedValueOnce(res('1')).mockResolvedValueOnce(res(null)))
    try {
      expect(await platform.serverBackup!.download('parola')).toEqual({ ok: true, restorable: false })
      expect(await platform.serverBackup!.download('parola')).toEqual({ ok: true, restorable: true })
      expect(await platform.serverBackup!.download('parola')).toEqual({ ok: true, restorable: true })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('web: saveBytes JSON üzerinden gelen bayt nesnesini de Blob yapar', async () => {
    const { platform } = await load({})
    const blobs: Blob[] = []
    vi.stubGlobal('URL', { createObjectURL: (b: Blob) => (blobs.push(b), 'blob:x'), revokeObjectURL: () => {} })
    vi.stubGlobal('document', {
      createElement: () => ({ style: {}, click: () => {}, remove: () => {} }),
      body: { appendChild: () => {} }
    })
    try {
      // WebSocket JSON'unda Uint8Array {"0":..,"1":..} nesnesine dönüşür
      const wire = JSON.parse(JSON.stringify(new Uint8Array([104, 105]))) as Uint8Array
      expect(await platform.saveBytes('a.eml', wire)).toBe(true)
      expect(await platform.saveBytes('b.eml', new Uint8Array([1, 2, 3]))).toBe(true)
      expect(await blobs[0].text()).toBe('hi')
      expect(blobs[1].size).toBe(3)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('web: OAuth sayfası yeni sekmede, opener kesilir; engellenirse false', async () => {
    const tab = { opener: {} as unknown }
    const open = vi.fn((): object | null => tab)
    const { platform } = await load({ open })
    expect(await platform.openOAuthUrl('https://accounts.example.com/x')).toBe(true)
    expect(open).toHaveBeenCalledWith('https://accounts.example.com/x', '_blank')
    expect(tab.opener).toBeNull()
    open.mockReturnValueOnce(null)
    expect(await platform.openOAuthUrl('https://accounts.example.com/y')).toBe(false)
  })

  it('web: OAuth penceresi tıklamada boş açılır, adres sonra verilir; engellenirse null', async () => {
    const tab = { opener: {} as unknown, location: { href: 'about:blank' }, closed: true, close: vi.fn() }
    const open = vi.fn((): object | null => tab)
    const { platform } = await load({ open })
    const w = platform.oauthWindow!()
    expect(open).toHaveBeenCalledWith('about:blank', '_blank')
    expect(tab.opener).toBeNull()
    w!.go('https://accounts.example.com/x')
    expect(tab.location.href).toBe('https://accounts.example.com/x')
    w!.close()
    expect(tab.close).toHaveBeenCalled()
    open.mockReturnValueOnce(null)
    expect(platform.oauthWindow!()).toBeNull()
  })

  it('web: OAuth penceresi kapanana dek kapatma yinelenir (dönüş sayfası işlenmeden yok sayılan kapatma)', async () => {
    vi.useFakeTimers()
    try {
      // WebKit: pencerede hâlâ başka kökenli belge varken close() sessizce yok sayılır
      const tab = { opener: {} as unknown, location: { href: '' }, closed: false, close: vi.fn(() => undefined as void) }
      tab.close.mockImplementation(() => {
        if (tab.close.mock.calls.length >= 3) tab.closed = true
      })
      const { platform } = await load({ open: () => tab })
      platform.oauthWindow!()!.close()
      expect(tab.closed).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(tab.closed).toBe(true)
      expect(tab.close).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('web: kapanmayan OAuth penceresi için yineleme sınırlı', async () => {
    vi.useFakeTimers()
    try {
      const tab = { opener: {} as unknown, location: { href: '' }, closed: false, close: vi.fn() }
      const { platform } = await load({ open: () => tab })
      platform.oauthWindow!()!.close()
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      const n = tab.close.mock.calls.length
      expect(n).toBeGreaterThan(1)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(tab.close.mock.calls.length).toBe(n)
    } finally {
      vi.useRealTimers()
    }
  })

  it('web: OAuth tamamlama bu sayfadan POST /oauth/complete ile', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    let status = 204
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(status === 204 ? null : JSON.stringify({ reason: 'invalid' }), { status })
    })
    try {
      const { platform } = await load({})
      expect(await platform.oauthComplete!('st')).toEqual({ ok: true })
      expect(calls[0].url).toBe('/oauth/complete')
      expect(calls[0].init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: JSON.stringify({ state: 'st' }) })
      expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
      status = 400
      expect(await platform.oauthComplete!('st')).toEqual({ ok: false, reason: 'invalid' })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('window.gecko varken electron ve çağrılar köprüye iletilir', async () => {
    const gecko = {
      savedLocale: 'de',
      setLocale: vi.fn(),
      touchIdAvailable: vi.fn(async () => true),
      promptTouchId: vi.fn(async () => true),
      reveal: vi.fn(async () => {}),
      openPath: vi.fn(async () => {}),
      saveFileAs: vi.fn(async () => true),
      chooseBackupSave: vi.fn(async () => '/yedek.geckobak'),
      chooseBackupOpen: vi.fn(async () => '/yedek.geckobak'),
      relaunch: vi.fn(async () => {}),
      getFilePath: vi.fn(() => '/disk/kisiler.csv'),
      trashFile: vi.fn(async () => true),
      openOAuthUrl: vi.fn(async () => true),
      openWallboard: vi.fn(async () => {}),
      wallboardPush: vi.fn()
    }
    const { platform } = await load({ gecko })
    const { rpc } = await import('../rpcClient')
    expect(platform.kind).toBe('electron')
    expect(platform.oauthWindow).toBeNull()
    expect(platform.oauthComplete).toBeNull()
    expect(platform.savedLocale()).toBe('de')
    platform.setLocale('fr')
    expect(gecko.setLocale).toHaveBeenCalledWith('fr')
    expect(await platform.biometricAvailable()).toBe(true)
    expect(await platform.promptBiometric('neden')).toBe(true)
    expect(gecko.promptTouchId).toHaveBeenCalledWith('neden')

    const a = { messageId: 7, attachmentId: 3, name: 'ek.pdf' }
    await platform.openAttachment(a)
    expect(rpc.call).toHaveBeenCalledWith('getAttachment', { messageId: 7, attachmentId: 3 })
    expect(gecko.openPath).toHaveBeenCalledWith('/tmp/ek.pdf', 'ek.pdf')
    await platform.revealAttachment(a)
    expect(gecko.reveal).toHaveBeenCalledWith('/tmp/ek.pdf')

    const data = new Uint8Array([1, 2])
    expect(await platform.saveBytes('x.eml', data)).toBe(true)
    expect(gecko.saveFileAs).toHaveBeenCalledWith('x.eml', data)
    expect(await platform.chooseBackupSave('a.geckobak', true)).toBe('/yedek.geckobak')
    expect(gecko.chooseBackupSave).toHaveBeenCalledWith('a.geckobak', true)
    expect(await platform.chooseBackupOpen()).toBe('/yedek.geckobak')
    await platform.relaunch()
    expect(gecko.relaunch).toHaveBeenCalled()
    expect(platform.filePath({} as File)).toBe('/disk/kisiler.csv')
    expect(await platform.trashFile('/disk/kisiler.csv')).toBe(true)
    expect(await platform.openOAuthUrl('https://x')).toBe(true)
    expect(gecko.openOAuthUrl).toHaveBeenCalledWith('https://x')

    expect(platform.uploadFile).toBeNull()
    expect(platform.discardUpload).toBeNull()
    expect(platform.wallboard).not.toBeNull()
    await platform.wallboard!.open()
    expect(gecko.openWallboard).toHaveBeenCalled()
    platform.wallboard!.push({ a: 1 })
    expect(gecko.wallboardPush).toHaveBeenCalledWith({ a: 1 })
  })

  describe('sunucu modu köprüsü', () => {
    const bridge = () => {
      const listeners: ((e: { event: string; data: unknown }) => void)[] = []
      return {
        listeners,
        wallboard: { open: vi.fn(async () => {}), push: vi.fn() },
        openSystemBrowser: vi.fn(async () => {}),
        onLocalEvent: vi.fn((cb: (e: { event: string; data: unknown }) => void) => void listeners.push(cb)),
        rendererReady: vi.fn()
      }
    }

    it('oturum bitişi ana sürece gider: sayfa yenilenmeden iptal edilen oturumda tıklama giriş sonrasına kalır', async () => {
      const g = bridge()
      const { platform } = await load({ geckoDesktop: g })
      platform.rendererReady(true)
      platform.rendererReady(false)
      expect(g.rendererReady.mock.calls).toEqual([[true], [false]])
    })

    it('web platform unchanged without bridge', async () => {
      const { platform } = await load({})
      expect(platform.kind).toBe('web')
      expect(platform.nativeNotifications).toBe(false)
      expect(platform.oauthExternal).toBeNull()
      expect(platform.oauthWindow).not.toBeNull()
      expect(platform.wallboard).toBeNull()
      expect(platform.wrapTransport).toBeNull()
      expect(platform.serverMode).toBeNull()
    })

    it('köprü varsa web tabanı üstüne yalnız masaüstü alanları', async () => {
      const geckoDesktop = bridge()
      const { platform } = await load({ geckoDesktop })
      expect(platform.kind).toBe('web')
      expect(platform.nativeNotifications).toBe(true)
      expect(platform.oauthWindow).toBeNull()
      expect(platform.serverBackup).not.toBeNull()
      await platform.wallboard!.open()
      expect(geckoDesktop.wallboard.open).toHaveBeenCalled()
      platform.wallboard!.push({ a: 1 })
      expect(geckoDesktop.wallboard.push).toHaveBeenCalledWith({ a: 1 })
      platform.oauthExternal!()
      expect(geckoDesktop.openSystemBrowser).toHaveBeenCalledWith('/')
    })

    it('yerel olaylar sarılan taşımanın olay akışına girer, kapanınca durur', async () => {
      const geckoDesktop = bridge()
      const { platform } = await load({ geckoDesktop })
      const inner = { start: vi.fn(), send: vi.fn(), close: vi.fn() }
      const wrapped = platform.wrapTransport!(inner)
      const onMessage = vi.fn()
      const onState = vi.fn()
      wrapped.start(onMessage, onState)
      expect(inner.start).toHaveBeenCalledWith(onMessage, onState)
      geckoDesktop.listeners[0]({ event: 'local:menu', data: { action: 'settings' } })
      expect(onMessage).toHaveBeenCalledWith({ event: 'local:menu', data: { action: 'settings' } })
      geckoDesktop.listeners[0]({ event: 'server:notify', data: {} }) // yalnız yerel olaylar
      expect(onMessage).toHaveBeenCalledTimes(1)
      wrapped.send({ id: 1 })
      expect(inner.send).toHaveBeenCalledWith({ id: 1 })
      wrapped.close()
      expect(inner.close).toHaveBeenCalled()
      geckoDesktop.listeners[0]({ event: 'local:menu', data: { action: 'settings' } })
      expect(onMessage).toHaveBeenCalledTimes(1)
    })

    it('electron platformu bildirimi kendisi gösterir, sunucu moduna geçiş köprüsü platformda', async () => {
      const serverMode = { probe: vi.fn(), connect: vi.fn() }
      const { platform } = await load({ gecko: { savedLocale: null, serverMode } })
      expect(platform.nativeNotifications).toBe(true)
      expect(platform.oauthExternal).toBeNull()
      expect(platform.serverMode).toBe(serverMode)
    })
  })

  it('electron: kayıtlı dil yoksa null', async () => {
    const { platform } = await load({ gecko: { savedLocale: null } })
    expect(platform.savedLocale()).toBeNull()
  })
})
