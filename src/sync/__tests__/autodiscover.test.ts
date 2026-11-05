import { describe, expect, it } from 'vitest'
import { discover, parseAutoconfig, type DiscoverDeps } from '../autodiscover'

const XML = (host: string, imapPort = 993, smtpPort = 465, socket = 'SSL') => `<?xml version="1.0"?>
<clientConfig version="1.1"><emailProvider id="x">
  <displayShortName>Örnek</displayShortName>
  <incomingServer type="pop3"><hostname>pop.${host}</hostname><port>995</port><socketType>SSL</socketType></incomingServer>
  <incomingServer type="imap"><hostname>${host}</hostname><port>143</port><socketType>plain</socketType><username>%EMAILADDRESS%</username></incomingServer>
  <incomingServer type="imap"><hostname>${host}</hostname><port>${imapPort}</port><socketType>${socket}</socketType><username>%EMAILLOCALPART%</username></incomingServer>
  <outgoingServer type="smtp"><hostname>smtp.${host}</hostname><port>${smtpPort}</port><socketType>STARTTLS</socketType></outgoingServer>
</emailProvider></clientConfig>`

function deps(o: Partial<DiscoverDeps> & { xml?: Record<string, string> } = {}): DiscoverDeps & { fetched: string[]; probed: string[] } {
  const fetched: string[] = []
  const probed: string[] = []
  return {
    fetched,
    probed,
    fetchText: async (url) => {
      fetched.push(url)
      const hit = Object.entries(o.xml ?? {}).find(([k]) => url.startsWith(k))
      return hit ? hit[1] : null
    },
    resolveMx: o.resolveMx ?? (async () => []),
    resolveSrv: o.resolveSrv ?? (async () => []),
    probeImap: o.probeImap ?? (async (h, p) => (probed.push(`${h}:${p}`), true))
  }
}

describe('autoconfig ayrıştırma', () => {
  it('düz metin sunucuyu atlar, SSL tercih eder, yer tutucuları doldurur', () => {
    const c = parseAutoconfig(XML('mx.test'), 'ali@firma.co')!
    expect(c).toMatchObject({ imapHost: 'mx.test', imapPort: 993, imapTls: 'tls', smtpHost: 'smtp.mx.test', smtpPort: 465, smtpTls: 'starttls', username: 'ali', label: 'Örnek' })
  })
  it('eksik ya da bozuk XML null', () => {
    expect(parseAutoconfig('<clientConfig/>', 'a@b.co')).toBeNull()
    expect(parseAutoconfig(XML('bad host!'), 'a@b.co')).toBeNull()
  })
})

describe('sunucu keşfi', () => {
  it('bilinen sağlayıcı ağa çıkmadan döner', async () => {
    const d = deps()
    const r = await discover('x@gmail.com', d)
    expect(r).toMatchObject({ imapHost: 'imap.gmail.com', label: 'Gmail', appPassword: true, source: 'Bilinen sağlayıcı', verified: true })
    expect(d.fetched).toEqual([])
  })

  it('alan adının autoconfig kaydı; e-posta sorguya eklenir', async () => {
    const d = deps({ xml: { 'https://autoconfig.firma.co/': XML('mail.host.co') } })
    const r = await discover('Ali@Firma.co', d)
    expect(r).toMatchObject({ imapHost: 'mail.host.co', source: 'Alan adının autoconfig kaydı', verified: true })
    expect(d.fetched[0]).toBe('https://autoconfig.firma.co/mail/config-v1.1.xml?emailaddress=ali%40firma.co')
  })

  it('SRV kaydı (öncelik/ağırlık) autoconfig yoksa', async () => {
    const d = deps({
      resolveSrv: async (n) =>
        n.startsWith('_imaps')
          ? [{ name: 'b.host.co', port: 993, priority: 10, weight: 0 }, { name: 'a.host.co', port: 993, priority: 0, weight: 1 }]
          : n.startsWith('_submissions')
            ? [{ name: 'smtp.host.co', port: 465, priority: 0, weight: 0 }]
            : []
    })
    expect(await discover('ali@firma.co', d)).toMatchObject({ imapHost: 'a.host.co', smtpHost: 'smtp.host.co', smtpTls: 'tls', source: 'DNS SRV kaydı' })
  })

  it('MX: kendi sunucusu → MX sunucusunun autoconfig kaydı, yoksa MX sunucusu', async () => {
    const withXml = deps({ resolveMx: async () => [{ exchange: 'mail.example.test.', priority: 10 }], xml: { 'https://mail.example.test/mail/': XML('mx.example.test') } })
    expect(await discover('info@musteri.example.test', withXml)).toMatchObject({ imapHost: 'mx.example.test', source: 'Mail sunucusunun autoconfig kaydı (MX)' })
    const bare = deps({ resolveMx: async () => [{ exchange: 'mx2.host.co', priority: 20 }, { exchange: 'mx1.host.co', priority: 10 }] })
    expect(await discover('a@firma.co', bare)).toMatchObject({ imapHost: 'mx1.host.co', source: 'MX kaydı' })
  })

  it('MX bilinen sağlayıcıysa (Google Workspace) onun ayarları', async () => {
    const d = deps({ resolveMx: async () => [{ exchange: 'aspmx.l.google.com', priority: 1 }] })
    expect(await discover('a@sirket.com', d)).toMatchObject({ imapHost: 'imap.gmail.com', appPassword: true })
  })

  it('şifresiz autoconfig yalnız alan adı/MX ile tutarlıysa kabul edilir', async () => {
    const evil = deps({ xml: { 'http://autoconfig.firma.co/': XML('saldirgan.net') } })
    expect((await discover('a@firma.co', evil)).imapHost).toBe('mail.firma.co')
    const ok = deps({ xml: { 'http://autoconfig.firma.co/': XML('imap.firma.co') } })
    expect((await discover('a@firma.co', ok)).imapHost).toBe('imap.firma.co')
  })

  it('ilk aday yanıt vermezse sıradaki denenir; hiçbiri vermezse doğrulanmamış', async () => {
    const d = deps({ xml: { 'https://autoconfig.firma.co/': XML('olu.host.co') }, probeImap: async (h) => h === 'mail.firma.co' })
    expect(await discover('a@firma.co', d)).toMatchObject({ imapHost: 'mail.firma.co', verified: true })
    const none = deps({ probeImap: async () => false })
    expect(await discover('a@firma.co', none)).toMatchObject({ imapHost: 'mail.firma.co', verified: false })
  })

  it('geçersiz adres', async () => {
    await expect(discover('yok', deps())).rejects.toThrow('Geçerli')
  })
})
