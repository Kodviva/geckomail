import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../rpcClient', () => ({ rpc: { call: vi.fn(async () => []), on: vi.fn(() => () => {}) } }))
vi.mock('../platform', () => ({ platform: { kind: 'web' }, UploadError: class {} }))
const h = vi.hoisted(() => ({ bp: 'wide' as 'wide' | 'medium' | 'narrow' }))
vi.mock('../layout/useBreakpoint', async (orig) => ({ ...(await orig<typeof import('../layout/useBreakpoint')>()), useBreakpoint: () => h.bp }))

describe('kişiler sayfası', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })

  it('appView restores mail selection', async () => {
    const { useStore } = await import('../store')
    useStore.setState({ selectedMessageId: 7 })
    useStore.getState().setAppView('contacts')
    useStore.setState({ selectedContactId: 3 })
    useStore.getState().setAppView('mail')
    expect(useStore.getState()).toMatchObject({ appView: 'mail', selectedMessageId: 7, selectedContactId: null })
  })

  const render = async (selected: number | null): Promise<string> => {
    const { useStore } = await import('../store')
    // sunucu işleme başlangıç durumunu okur
    Object.assign(useStore.getInitialState(), { appView: 'contacts', selectedContactId: selected })
    const { default: ContactsPage } = await import('../components/contacts/ContactsPage')
    return renderToStaticMarkup(<ContactsPage />)
  }

  it('narrow shows one pane', async () => {
    h.bp = 'narrow'
    const list = await render(null)
    expect(list).toContain('pim-listpane')
    expect(list).not.toContain('pim-detailpane')
    const detail = await render(4)
    expect(detail).not.toContain('pim-listpane')
    expect(detail).toContain('pim-detailpane')
  })

  it('geniş ekranda iki bölme', async () => {
    h.bp = 'wide'
    const html = await render(null)
    expect(html).toContain('pim-listpane')
    expect(html).toContain('pim-detailpane')
  })
})
