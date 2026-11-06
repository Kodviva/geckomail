import { createServer, type AddressInfo } from 'net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AccountRow } from '../db/queries'
import { openConnection } from '../imapClient'
import { smtpErrorKind } from '../opQueue'
import { mailEndpoint, setMailNetPolicy } from '../net/mailNet'
import { smtpSendRaw } from '../smtpSend'
import { configFromEnv } from '../../server/config'

vi.mock('dns/promises', async (orig) => ({
  ...(await orig<typeof import('dns/promises')>()),
  lookup: vi.fn(async (host: string) => {
    if (host === 'ic.example.com') return [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.5', family: 4 }]
    if (host === 'cift.example.com') return [{ address: '2606:4700::1', family: 6 }, { address: '8.8.4.4', family: 4 }]
    if (host === 'genel.example.com') return [{ address: '8.8.8.8', family: 4 }]
    throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
  })
}))

afterEach(() => setMailNetPolicy(null))

describe('mailEndpoint', () => {
  it('masaüstü ilkesi serbest: iç adres ve çözülmeyen ad olduğu gibi geçer', async () => {
    expect(await mailEndpoint('127.0.0.1', 1143)).toEqual({ host: '127.0.0.1' })
    expect(await mailEndpoint('yok.invalid', 993)).toEqual({ host: 'yok.invalid' })
  })

  it('sunucu ilkesi iç adresi ve iç adrese çözülen adı reddeder', async () => {
    setMailNetPolicy(new Set())
    for (const h of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1']) await expect(mailEndpoint(h, 993), h).rejects.toThrow(h)
    await expect(mailEndpoint('ic.example.com', 993)).rejects.toThrow('ic.example.com')
  })

  it('genel ad denetlenen adrese kilitlenir, TLS adı alan adı kalır', async () => {
    setMailNetPolicy(new Set())
    expect(await mailEndpoint('genel.example.com', 993)).toEqual({ host: '8.8.8.8', servername: 'genel.example.com' })
    expect(await mailEndpoint('cift.example.com', 993)).toEqual({ host: '8.8.4.4', servername: 'cift.example.com' })
    expect(await mailEndpoint('8.8.8.8', 993)).toEqual({ host: '8.8.8.8' })
  })

  it('çözülemeyen ad ağ hatası kalır', async () => {
    setMailNetPolicy(new Set())
    await expect(mailEndpoint('yok.invalid', 993)).rejects.toMatchObject({ code: 'ENOTFOUND' })
  })

  it('izin listesi ad ya da ad:port ile açar', async () => {
    setMailNetPolicy(new Set(['ic.example.com', '10.0.0.9:143']))
    expect(await mailEndpoint('IC.example.com', 993)).toEqual({ host: 'IC.example.com' })
    expect(await mailEndpoint('10.0.0.9', 143)).toEqual({ host: '10.0.0.9' })
    await expect(mailEndpoint('10.0.0.9', 993)).rejects.toThrow('10.0.0.9')
  })
})

describe('bağlantı süzgeci', () => {
  const account = (port: number) => ({
    email: 'a@t.co', imap_host: '127.0.0.1', imap_port: port, imap_tls: 'tls', smtp_host: '127.0.0.1', smtp_port: port, smtp_tls: 'tls',
    allow_invalid_certs: 1, auth_type: 'password'
  }) as unknown as AccountRow

  async function listener(): Promise<{ port: number; hits: () => number; close(): void }> {
    let hits = 0
    const srv = createServer((c) => {
      hits++
      c.destroy()
    })
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
    return { port: (srv.address() as AddressInfo).port, hits: () => hits, close: () => srv.close() }
  }

  it('sunucu kipinde IMAP iç adrese soket açmaz', async () => {
    const l = await listener()
    setMailNetPolicy(new Set())
    await expect(openConnection(account(l.port), 'p', { connectTimeoutMs: 500, socketTimeoutMs: 500 })).rejects.toMatchObject({ phase: 'connect' })
    expect(l.hits()).toBe(0)
    l.close()
  })

  it('sunucu kipinde SMTP iç adrese soket açmaz ve parola gitmez', async () => {
    const l = await listener()
    setMailNetPolicy(new Set())
    const err = await smtpSendRaw(account(l.port), 'p', { accountId: 1, to: 'x@y.co', subject: '', text: '' }, Buffer.from('x')).catch((e) => e)
    expect(err).toMatchObject({ phase: 'connect' })
    expect(smtpErrorKind(err)).toBe('other')
    expect(l.hits()).toBe(0)
    l.close()
  })

  it('masaüstü kipinde IMAP iç adrese bağlanmayı dener', async () => {
    const l = await listener()
    await openConnection(account(l.port), 'p', { connectTimeoutMs: 500, socketTimeoutMs: 500 }).catch(() => {})
    expect(l.hits()).toBe(1)
    l.close()
  })
})

describe('GECKO_MAIL_PRIVATE_HOSTS', () => {
  const base = { GECKO_PUBLIC_ORIGIN: 'https://posta.example.com' }
  it('küçük harfe iner, tanımsızsa boş', () => {
    expect(configFromEnv({ ...base, GECKO_MAIL_PRIVATE_HOSTS: ' Posta.Lan , ,mx.lan:587 ' }).mailPrivateHosts).toEqual(['posta.lan', 'mx.lan:587'])
    expect(configFromEnv(base).mailPrivateHosts).toEqual([])
  })
  it('geçersiz değer reddedilir', () => {
    for (const v of ['imap://x', 'x:0', 'x:70000']) expect(() => configFromEnv({ ...base, GECKO_MAIL_PRIVATE_HOSTS: v }), v).toThrow('GECKO_MAIL_PRIVATE_HOSTS')
  })
})
