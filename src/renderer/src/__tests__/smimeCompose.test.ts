import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageRow } from '../../../shared/rpc'
import type { RecipientStatus, SmimeInfo } from '../../../shared/smime'
import type { ComposerState, State } from '../store/types'
import { t } from '../../../shared/i18n'
import { composerAddresses, composerFromDraft, draftIsSensitive, setEncrypt, smimeRequest, smimeSendBlock, type SmimeCheck } from '../smimeCompose'

const h = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../rpcClient', () => ({ rpc: { call: h.call } }))
vi.mock('../platform', () => ({ platform: {}, UploadError: class {} }))
vi.mock('dompurify', () => ({ default: { sanitize: (s: string) => s } }))

const composer = (over: Partial<ComposerState> = {}): ComposerState => ({
  fromAccountId: 1, to: 'a@b.c', cc: '', bcc: '', subject: 's', text: 'gizli gövde', rich: false, html: '', attachments: [], ...over
})
const info = (enc: SmimeInfo['enc']): SmimeInfo => ({ sig: 'none', enc, notes: [], signer: null, canSaveCert: false })
const check = (status: RecipientStatus = 'ok', blocked: SmimeCheck['blocked'] = null): SmimeCheck => ({
  canSign: blocked === null || blocked === 'own_cert_missing', canEncrypt: blocked === null && status === 'ok', blocked, recipients: [{ address: 'a@b.c', status }]
})

describe('S/MIME oluşturucu', () => {
  let stored: Map<string, string>
  beforeEach(() => {
    h.call.mockReset()
    stored = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored.get(k) ?? null,
      setItem: (k: string, v: string) => void stored.set(k, v),
      removeItem: (k: string) => void stored.delete(k)
    })
    vi.stubGlobal('window', { confirm: () => true })
  })

  const start = async (over: Partial<State> = {}) => {
    const { composeSlice } = await import('../store/compose')
    let state = { composer: null, accounts: [{ id: 1, email: 'x@y.z', enabled: true }], contacts: [1], messages: [], selectedAccountIds: null, toast: vi.fn(), ...over } as unknown as State
    const set = (p: Partial<State>): void => {
      state = { ...state, ...p }
    }
    const get = (): State => state
    const slice = composeSlice(set as never, get as never)
    set({ setComposer: slice.setComposer })
    return { slice, get }
  }
  const msg = { id: 3, accountId: 1, subject: 'k', fromAddr: 'a@b.c', messageId: '<m>', date: 1, smimeKind: 'encrypted' } as unknown as MessageRow

  it('reply to encrypted turns encrypt on', async () => {
    const { slice, get } = await start({ messages: [msg], selectedMessageId: 3, body: { state: 'ready', textPlain: 'x', html: null, attachments: [], smime: info('decrypted') } })
    slice.openComposer('reply')
    expect(get().composer).toMatchObject({ smimeEncrypt: true, smimeSign: true, smimeSensitive: true })
  })

  it('iletme de korunur, gövde henüz gelmemiş olsa bile', async () => {
    const { slice, get } = await start({ messages: [msg], selectedMessageId: 3, body: null })
    slice.openComposer('forward')
    expect(get().composer).toMatchObject({ smimeEncrypt: true, smimeSensitive: true })
  })

  it('şifresiz iletiye yanıt varsayılan kapalı', async () => {
    const plain = { ...msg, smimeKind: null } as MessageRow
    const { slice, get } = await start({ messages: [plain], selectedMessageId: 3, body: { state: 'ready', textPlain: 'x', html: null, attachments: [] } })
    slice.openComposer('reply')
    expect(draftIsSensitive(get().composer!)).toBe(false)
    expect(smimeRequest(get().composer!)).toBeUndefined()
  })

  it('encrypt forces sign', () => {
    const c = setEncrypt(composer(), true)
    expect(c).toMatchObject({ smimeEncrypt: true, smimeSign: true })
    expect(smimeRequest(composer({ smimeEncrypt: true }))).toEqual({ sign: true, encrypt: true })
    expect(smimeRequest(composer({ smimeSign: true }))).toEqual({ sign: true, encrypt: false })
    expect(setEncrypt(c, false).smimeEncrypt).toBe(false)
  })

  it('duyarlı ileti şifre kapatılınca da duyarlı kalır', () => {
    const c = setEncrypt(composer({ smimeSensitive: true, smimeEncrypt: true, smimeSign: true }), false)
    expect(draftIsSensitive(c)).toBe(true)
  })

  it('missing recipient disables send', () => {
    const c = composer({ smimeEncrypt: true, smimeSign: true })
    expect(smimeSendBlock(c, { key: 'k', res: check('ok') }, 'k')).toBeNull()
    for (const s of ['missing', 'expired', 'revoked', 'weak', 'unsupported_key'] as RecipientStatus[]) {
      expect(smimeSendBlock(c, { key: 'k', res: check(s) }, 'k')).toContain(t(`smime.recipient.${s}`))
    }
    // bayat ya da bekleyen denetim sonucu Gönder'i açmaz
    expect(smimeSendBlock(c, { key: 'eski', res: check('ok') }, 'k')).toBe(t('smime.compose.checking'))
    expect(smimeSendBlock(c, null, 'k')).toBe(t('smime.compose.checking'))
  })

  it('engel nedenleri; yalnız imzada sertifika şifreye uygun olmasa da gönderilir', () => {
    const on = composer({ smimeEncrypt: true, smimeSign: true })
    expect(smimeSendBlock(on, { key: 'k', res: check('ok', 'vault_none') }, 'k')).toBe(t('smime.blocked.vault_none'))
    expect(smimeSendBlock(on, { key: 'k', res: check('ok', 'vault_locked') }, 'k')).toBe(t('smime.blocked.vault_locked'))
    expect(smimeSendBlock(on, { key: 'k', res: check('ok', 'no_identity') }, 'k')).toBe(t('smime.blocked.no_identity'))
    expect(smimeSendBlock(on, { key: 'k', res: check('ok', 'own_cert_missing') }, 'k')).toBe(t('smime.blocked.own_cert_missing'))
    const sign = composer({ smimeSign: true })
    expect(smimeSendBlock(sign, { key: 'k', res: check('ok', 'own_cert_missing') }, 'k')).toBeNull()
    expect(smimeSendBlock(sign, { key: 'k', res: check('ok', 'no_identity') }, 'k')).toBe(t('smime.blocked.no_identity'))
    expect(smimeSendBlock(composer(), null, 'k')).toBeNull()
  })

  it('Bcc sınırı Gönder öncesi görünür', () => {
    const bcc = Array.from({ length: 21 }, (_, i) => `b${i}@b.c`).join(', ')
    expect(smimeSendBlock(composer({ smimeEncrypt: true, smimeSign: true, bcc }), { key: 'k', res: check('ok') }, 'k')).toBe(t('sync.smime.tooManyBcc', { max: '20' }))
  })

  it('adresler görünen addan ve yinelenmeden ayrılır', () => {
    expect(composerAddresses(composer({ to: '"Soyad, Ad" <A@B.c>, c@d.e', cc: 'a@b.c', bcc: 'E@f.g,' }))).toEqual(['a@b.c', 'c@d.e', 'e@f.g'])
  })

  it('saveDraft stores no body for encrypted', async () => {
    const { slice } = await start()
    slice.setComposer(composer({ smimeEncrypt: true, smimeSign: true }))
    slice.setComposer(composer({ smimeSensitive: true }))
    expect(stored.size).toBe(0)
  })

  it('saved draft cleared when encrypt turned on', async () => {
    const { slice } = await start()
    slice.setComposer(composer())
    expect([...stored.values()].join()).toContain('gizli gövde')
    slice.setComposer(setEncrypt(composer(), true))
    expect(stored.size).toBe(0)
  })

  it('duyarlı taslak kapatılırken sorar, kayıtlı diye yalan söylemez', async () => {
    const confirm = vi.fn(() => false)
    vi.stubGlobal('window', { confirm })
    const { slice, get } = await start({ composer: composer({ smimeSensitive: true }) })
    slice.closeComposer()
    expect(confirm).toHaveBeenCalledOnce()
    expect(get().composer).not.toBeNull()
    expect(get().toast).not.toHaveBeenCalled()
  })

  it('send passes smime flags', async () => {
    const { slice } = await start({ composer: composer({ smimeEncrypt: true, smimeSign: true }) })
    h.call.mockResolvedValue(null)
    await slice.send(undefined)
    expect(h.call.mock.calls[0][1]).toMatchObject({ smime: { sign: true, encrypt: true } })
  })

  it('smime kapalıyken parametre gitmez', async () => {
    const { slice } = await start({ composer: composer() })
    h.call.mockResolvedValue(null)
    await slice.send(undefined)
    expect(h.call.mock.calls[0][1]).not.toHaveProperty('smime')
  })

  it('getOpDraft taslağı bayraklarla geri gelir, düz taslağa yazılmaz', async () => {
    const d = { accountId: 1, to: 'a@b.c', subject: 's', text: 'gizli gövde' }
    expect(composerFromDraft({ ...d, smime: { sign: true, encrypt: true } })).toMatchObject({ smimeEncrypt: true, smimeSign: true, smimeSensitive: true, to: 'a@b.c' })
    expect(composerFromDraft({ ...d, smime: { sign: true, encrypt: false } })).toMatchObject({ smimeSign: true })
    expect(draftIsSensitive(composerFromDraft(d))).toBe(false)
    const { slice } = await start()
    slice.setComposer(composerFromDraft({ ...d, smime: { sign: true, encrypt: true } }))
    expect(stored.size).toBe(0)
  })
})
