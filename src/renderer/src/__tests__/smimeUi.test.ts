import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentInfo, BodyResult, MessageRow } from '../../../shared/rpc'
import { setLocale, t } from '../../../shared/i18n'
import { smimeBadges, type SmimeEncState, type SmimeInfo, type SmimeNote, type SmimeSigState, type SmimeTone } from '../../../shared/smime'

vi.mock('../rpcClient', () => ({ rpc: { call: vi.fn() } }))
vi.mock('../platform', () => ({ platform: { kind: 'web' } }))
vi.mock('dompurify', () => ({ default: { addHook: () => {}, sanitize: (s: string) => s } }))
vi.mock('../layout/MobileNav', () => ({ BackButton: () => null, useNavDrawer: () => false }))
const h = vi.hoisted(() => ({ state: {} as Record<string, unknown> }))
vi.mock('../store', () => ({ useStore: Object.assign((sel: (s: unknown) => unknown) => sel(h.state), { getState: () => h.state }) }))

const info = (o: Partial<SmimeInfo>): SmimeInfo => ({ sig: 'none', enc: 'none', notes: [], signer: null, canSaveCert: false, ...o })

const ROWS: [SmimeEncState, SmimeSigState, SmimeNote[], SmimeTone, string, string][] = [
  ['decrypted', 'none', [], 'ok', 'Şifreli', 'Encrypted'],
  ['decrypted', 'none', ['weak_cipher'], 'warn', 'Şifreli, zayıf algoritma', 'Encrypted, weak cipher'],
  ['decrypted', 'none', ['unauthenticated'], 'warn', 'Şifreli, bütünlük doğrulanamadı', 'Encrypted, integrity not proven'],
  ['locked', 'none', [], 'muted', 'Şifreli: kasa kilitli', 'Encrypted: vault locked'],
  ['no_key', 'none', [], 'muted', 'Şifreli: anahtarınız yok', 'Encrypted: you have no key'],
  ['failed', 'none', [], 'bad', 'Şifre çözülemedi', 'Could not decrypt'],
  ['unsupported', 'none', [], 'muted', 'Desteklenmeyen şifreleme', 'Unsupported encryption'],
  ['none', 'verified', [], 'ok', 'İmza doğrulandı', 'Signature verified'],
  ['none', 'untrusted', [], 'warn', 'İmza doğrulanmadı: güvenilmeyen sertifika', 'Not verified: untrusted certificate'],
  ['none', 'untrusted', ['self_signed'], 'warn', 'İmza doğrulanmadı: kendinden imzalı', 'Not verified: self-signed'],
  ['none', 'expired', [], 'warn', 'Sertifika süresi geçmiş', 'Certificate expired'],
  ['none', 'address_mismatch', [], 'bad', 'Sertifika gönderenle eşleşmiyor', 'Certificate does not match sender'],
  ['none', 'weak_algorithm', [], 'warn', 'Zayıf imza algoritması', 'Weak signature algorithm'],
  ['none', 'revoked', [], 'bad', 'Sertifika iptal edilmiş', 'Certificate revoked'],
  ['none', 'invalid', [], 'bad', 'İmza geçersiz: ileti değişmiş olabilir', 'Invalid signature: message may be altered'],
  ['none', 'unsupported', [], 'muted', 'İmza denetlenemedi', 'Signature could not be checked']
]

describe('sertifika kaydetme', () => {
  const signer = { email: 'a@example.test', subject: 's', issuer: 'i', fingerprint: 'AB:CD', notBefore: 1, notAfter: 2 }
  const render = async (): Promise<string> => {
    const { SmimeDetail } = await import('../components/SmimeBadges')
    return renderToStaticMarkup(createElement(SmimeDetail, { info: info({ sig: 'untrusted', signer, canSaveCert: true }), messageId: 1 }))
  }
  afterEach(async () => {
    const { platform } = await import('../platform')
    delete (platform as { native?: string }).native
  })

  it('düğme parmak iziyle görünür, onay metni 11 dilde parmak izini taşır', async () => {
    const html = await render()
    expect(html).toContain('AB:CD')
    expect(html).toContain(t('smime.detail.save'))
    for (const l of ['tr', 'en', 'de', 'fr', 'es', 'pt', 'ru', 'ja', 'zh', 'ar', 'hi']) {
      setLocale(l as Parameters<typeof setLocale>[0])
      expect(t('smime.detail.saveConfirm', { fingerprint: 'AB:CD' }), l).toContain('AB:CD')
    }
    setLocale('tr')
  })

  it('mobilde düğme yok: biletli soket reddeder', async () => {
    const { platform } = await import('../platform')
    ;(platform as { native?: string }).native = 'ios'
    expect(await render()).not.toContain(t('smime.detail.save'))
  })
})

describe('atıf', () => {
  it('atıf ve kaynak bağlantısı görünür', async () => {
    const { default: Attribution } = await import('../components/Attribution')
    const html = renderToStaticMarkup(createElement(Attribution, {}))
    expect(html).toContain('GeckoMail · Kodviva')
    expect(html).toContain('href="https://github.com/kodviva/geckomail"')
    expect(html).toContain(t('set.about.source'))
  })
})

describe('Oturumlarım', () => {
  it('geçerli oturumda kapatma düğmesi yok, diğerinde var', async () => {
    const { SessionRows } = await import('../components/SessionsSettings')
    const list = [
      { id: 'a', kind: 'web' as const, label: 'Safari · macOS', lastSeenAt: 1, current: true },
      { id: 'b', kind: 'mobile' as const, label: 'iPhone', lastSeenAt: 2, current: false }
    ]
    const html = renderToStaticMarkup(createElement(SessionRows, { list, busy: false, onRevoke: () => {} }))
    expect(html).toContain(`Safari · macOS · ${t('set.sessions.current')}`)
    expect(html).toContain(t('set.sessions.mobile'))
    expect(html.split('<button').length - 1).toBe(1)
    expect(html).toContain(`${t('set.sessions.revoke')}: iPhone`)
  })
})

describe('S/MIME rozetleri', () => {
  afterEach(() => setLocale('tr'))

  it.each(ROWS)('enc=%s sig=%s %j', (enc, sig, notes, tone, tr, en) => {
    const [b, extra] = smimeBadges(info({ enc, sig, notes }))
    expect(extra).toBeUndefined()
    expect(b.tone).toBe(tone)
    setLocale('tr')
    expect(t(b.labelKey)).toBe(tr)
    expect(t(b.detailKey)).not.toBe(b.detailKey)
    setLocale('en')
    expect(t(b.labelKey)).toBe(en)
    expect(t(b.detailKey)).not.toBe(b.detailKey)
  })

  it('yalnız iki durum yeşil', () => {
    const green = ROWS.filter(([enc, sig, notes]) => smimeBadges(info({ enc, sig, notes }))[0].tone === 'ok')
    expect(green.map(([enc, sig]) => [enc, sig])).toEqual([['decrypted', 'none'], ['none', 'verified']])
  })

  it('untrusted ve self_signed "doğrulandı" demez', () => {
    for (const notes of [[], ['self_signed']] as SmimeNote[][]) {
      const [b] = smimeBadges(info({ sig: 'untrusted', notes }))
      setLocale('tr')
      expect(t(b.labelKey)).not.toContain('doğrulandı')
      expect(t(b.detailKey)).not.toContain('doğrulandı')
      setLocale('en')
      expect(t(b.labelKey)).not.toContain('Signature verified')
      expect(t(b.detailKey)).not.toContain('Signature verified')
    }
  })
})

describe('S/MIME görünümü', () => {
  const msg: MessageRow = {
    id: 7, accountId: 1, folderId: 1, subject: 'Konu', fromName: 'A', fromAddr: 'a@b.c', toJson: '[]', date: 1, seen: true, flagged: false,
    locked: false, smimeKind: 'encrypted', threadRoot: null, canUnsubscribe: false
  } as unknown as MessageRow

  const render = async (body: BodyResult, m: MessageRow = msg): Promise<string> => {
    h.state = {
      selectedMessageId: m.id, messages: [m], body, accounts: [{ id: 1, email: 'x@y.z', color: '#000' }], allowRemoteImages: false, offlineMode: false,
      currentUser: null, setAllowRemoteImages: () => {}, openComposer: () => {}, deleteMessages: () => {}, markSeen: () => {}, setFlagged: () => {}, refreshBody: () => {},
      openMoveDialog: () => {}, moveSpecial: () => {}, openContextMenu: () => {}, toast: () => {}, folderKind: 'inbox', select: () => {}, setVaultPromptOpen: () => {}
    }
    const { default: MessageView } = await import('../components/MessageView')
    return renderToStaticMarkup(createElement(MessageView))
  }
  const ready = (o: Partial<Extract<BodyResult, { state: 'ready' }>>): BodyResult => ({ state: 'ready', textPlain: null, html: null, attachments: [], ...o })
  const remoteHtml = '<img src="https://izleyici.example/p.png">'

  beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} }))

  it('remote bar hidden for decrypted', async () => {
    const html = await render(ready({ html: remoteHtml, smime: info({ enc: 'decrypted', sig: 'verified' }) }))
    expect(html).not.toContain(t('mail.view.remoteBlocked'))
    expect(html).not.toContain('izleyici.example')
  })

  it('şifresiz imzalı iletide uzak resim çubuğu kalır', async () => {
    const html = await render(ready({ html: remoteHtml, smime: info({ sig: 'verified' }) }), { ...msg, smimeKind: 'signed' })
    expect(html).toContain(t('mail.view.remoteBlocked'))
  })

  it('attachment chip offers save only', async () => {
    const a: AttachmentInfo = { id: -1, smimeIndex: 0, filename: 'gizli.pdf', mime: 'application/pdf', size: 10, contentId: null, diskPath: null }
    const html = await render(ready({ textPlain: 'x', attachments: [a], smime: info({ enc: 'decrypted' }) }))
    expect(html).toContain('gizli.pdf')
    expect(html).toContain(t('smime.att.save'))
    expect(html).not.toContain(t('mail.att.open'))
    expect(html).not.toContain(t('mail.att.reveal'))
  })

  it('kilitli şifreli iletide kasayı aç düğmesi ve rozet', async () => {
    const html = await render(ready({ smime: info({ enc: 'locked' }) }))
    expect(html).toContain(t('smime.enc.locked'))
    expect(html).toContain(t('smime.detail.unlock'))
    expect(html).not.toContain(t('mail.view.emptyBody'))
  })

  it('rozet ayrıntısı imzacı ve notları gösterir, kaydetme parmak iziyle', async () => {
    const { SmimeDetail } = await import('../components/SmimeBadges')
    const signer = { email: 'alice@example.test', subject: 'CN=Alice', issuer: 'CN=Kok', fingerprint: 'ab:cd', notBefore: 0, notAfter: 1 }
    const html = renderToStaticMarkup(createElement(SmimeDetail, {
      info: info({ sig: 'untrusted', notes: ['self_signed', 'revocation_unknown', 'cert_expired_since', 'header_mismatch', 'too_large'], signer, canSaveCert: true }),
      messageId: 7
    }))
    for (const s of ['alice@example.test', 'CN=Alice', 'CN=Kok', 'ab:cd', t('smime.detail.save')]) expect(html).toContain(s)
    for (const k of ['revocation_unknown', 'cert_expired_since', 'header_mismatch', 'too_large']) expect(html).toContain(t(`smime.note.${k}`))
  })
})
