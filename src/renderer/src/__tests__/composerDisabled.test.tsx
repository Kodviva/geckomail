import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../rpcClient', () => ({ rpc: { call: vi.fn() } }))
vi.mock('../platform', () => ({ platform: {}, UploadError: class {} }))
vi.mock('dompurify', () => ({ default: { sanitize: (s: string) => s } }))
// zustand sunucu işlemede başlangıç durumunu okur; seçiciyi doğrudan sahte duruma uygula
const h = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('../store', () => ({ useStore: Object.assign((sel: (s: unknown) => unknown) => sel(h.state), { getState: () => h.state }) }))
vi.mock('../components/Modal', () => ({ default: ({ children }: { children: unknown }) => <div>{children as never}</div> }))

describe('Composer alanları', () => {
  const render = async (sending: boolean, rich: boolean): Promise<string> => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    h.state = {
      sending,
      accounts: [],
      contacts: [],
      toast: () => {},
      setComposer: () => {},
      closeComposer: () => {},
      send: () => {},
      addAttachments: () => {},
      removeAttachment: () => {},
      composer: { fromAccountId: 1, to: 'a@b.c', cc: '', bcc: '', subject: 's', text: 't', rich, html: '<p>x</p>', attachments: [] }
    }
    const { default: Composer } = await import('../components/Composer')
    return renderToStaticMarkup(<Composer />)
  }

  it('composer inputs disabled while sending', async () => {
    const html = await render(true, false)
    const inputs = html.match(/<(input|textarea|select)\b[^>]*>/g) ?? []
    const visible = inputs.filter((x) => !/type="file"/.test(x))
    expect(visible.length).toBeGreaterThanOrEqual(5)
    for (const el of visible) expect(el).toMatch(/disabled=""/)
  })

  it('gönderim yokken alanlar açık', async () => {
    const html = await render(false, false)
    const textarea = (html.match(/<textarea\b[^>]*>/) ?? [''])[0]
    expect(textarea).toContain('<textarea')
    expect(textarea).not.toMatch(/disabled/)
  })

  it('zengin editör gönderim sürerken düzenlenemez', async () => {
    expect(await render(true, true)).toContain('contentEditable="false"')
    expect(await render(false, true)).toContain('contentEditable="true"')
  })
})
