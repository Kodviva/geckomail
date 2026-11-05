import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternal, showMessageBox } = vi.hoisted(() => ({ openExternal: vi.fn(), showMessageBox: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showMessageBox }, shell: { openExternal } }))

import { openExternalHandler } from '../externalLinks'

describe('openExternalHandler', () => {
  let now = 0
  const handler = () => openExternalHandler(() => null, () => now)
  beforeEach(() => {
    now = 0
    openExternal.mockClear()
    showMessageBox.mockReset()
  })

  it('izinli şema tarayıcıda açılır, pencere hep reddedilir', () => {
    expect(handler()({ url: 'https://a.example/' })).toEqual({ action: 'deny' })
    expect(handler()({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(openExternal.mock.calls).toEqual([['https://a.example/']])
  })

  it('sayfa sistem tarayıcısını sekmeye boğamaz', () => {
    const h = handler()
    for (let i = 0; i < 50; i++) h({ url: `https://a.example/${i}` })
    expect(openExternal.mock.calls.length).toBe(5)
    now = 11_000
    h({ url: 'https://a.example/son' })
    expect(openExternal.mock.calls.length).toBe(6)
  })

  it('punycode uyarısı ana süreci bloklamaz, onaysız açılmaz', async () => {
    showMessageBox.mockResolvedValue({ response: 0 })
    handler()({ url: 'https://xn--e1a.example/' })
    await vi.waitFor(() => expect(showMessageBox).toHaveBeenCalled())
    await Promise.resolve()
    expect(openExternal).not.toHaveBeenCalled()
  })

  it('onaylanırsa açılır; açık uyarı varken ikincisi sorulmaz', async () => {
    let answer: (v: { response: number }) => void = () => {}
    showMessageBox.mockReturnValue(new Promise((r) => { answer = r }))
    const h = handler()
    h({ url: 'https://xn--e1a.example/' })
    h({ url: 'https://xn--e1b.example/' })
    expect(showMessageBox).toHaveBeenCalledTimes(1)
    answer({ response: 1 })
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://xn--e1a.example/'))
  })
})
