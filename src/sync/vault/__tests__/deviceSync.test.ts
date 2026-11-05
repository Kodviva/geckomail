import { describe, expect, it } from 'vitest'
import { actionsFromPortable, actionsToPortable, decodeSyncBlob, encodeSyncBlob, remotePasswordWins, SYNC_VERSION, type SyncConfig } from '../../deviceSync'

const CONFIG: SyncConfig = {
  version: SYNC_VERSION,
  exportedAt: 1_700_000_000_000,
  accounts: [
    {
      email: 'ops@example.test',
      displayName: 'Ops',
      imapHost: 'mail.example.test',
      imapPort: 993,
      imapTls: 'tls',
      smtpHost: 'mail.example.test',
      smtpPort: 465,
      smtpTls: 'tls',
      color: '#b6924f',
      signature: 'Saygılar',
      allowInvalidCerts: false,
      groupName: 'Genel',
      password: 'süper-gizli-şifre-çğş'
    }
  ],
  groups: [{ name: 'Genel', color: '#8d7ba6' }],
  rules: [
    {
      name: 'DMARC arşivle',
      enabled: true,
      accountEmail: null,
      groupName: 'Genel',
      conditions: { subjectContains: 'dmarc' },
      actions: [{ type: 'archive' }]
    }
  ]
}

describe('deviceSync blob', () => {
  it('encode→decode round-trip config eşit', () => {
    const back = decodeSyncBlob(encodeSyncBlob(CONFIG, 'senkron-parolam'), 'senkron-parolam')
    expect(back).toEqual(CONFIG)
    expect(back.accounts[0].password).toBe('süper-gizli-şifre-çğş')
  })

  it('yanlış parola → hata (sessizce yanlış veri değil)', () => {
    const blob = encodeSyncBlob(CONFIG, 'doğru')
    expect(() => decodeSyncBlob(blob, 'yanlış')).toThrow()
  })

  it('blob salt önekli — aynı config+parola her seferinde farklı çıktı', () => {
    const a = encodeSyncBlob(CONFIG, 'p')
    const b = encodeSyncBlob(CONFIG, 'p')
    expect(a.equals(b)).toBe(false)
    // yine de ikisi de aynı config'e çözülür
    expect(decodeSyncBlob(a, 'p')).toEqual(decodeSyncBlob(b, 'p'))
  })

  it('bozuk/kısa blob → hata', () => {
    expect(() => decodeSyncBlob(Buffer.from('kısa'), 'p')).toThrow()
  })
})

describe('remotePasswordWins — eski şifre yeniyi ezmesin', () => {
  it('yeni hesapta uzak şifre uygulanır', () => {
    expect(remotePasswordWins(true, null, undefined)).toBe(true)
  })
  it('damgasız (eski sürüm) blob var olan şifreye dokunmaz', () => {
    expect(remotePasswordWins(false, 0, undefined)).toBe(false)
    expect(remotePasswordWins(false, 1_700_000_000_000, 0)).toBe(false)
  })
  it('yalnız kesin olarak daha yeni uzak şifre kazanır', () => {
    expect(remotePasswordWins(false, 1000, 2000)).toBe(true)
    expect(remotePasswordWins(false, 2000, 2000)).toBe(false)
    expect(remotePasswordWins(false, 3000, 2000)).toBe(false)
  })
})

describe('kural webhook eşlemesi (R36)', () => {
  it('dışa aktarırken ada, içe alırken yerel id\'ye çevrilir', () => {
    const portable = actionsToPortable([{ type: 'archive' }, { type: 'webhook', webhookId: 7 }], new Map([[7, 'Slack ops']]))
    expect(portable).toEqual([{ type: 'archive' }, { type: 'webhook', webhookId: 7, webhookName: 'Slack ops' }])
    const local = actionsFromPortable(portable, new Map([['Slack ops', 42]]))
    expect(local).toEqual([{ type: 'archive' }, { type: 'webhook', webhookId: 42 }])
  })
  it('karşılığı olmayan webhook eylemi düşürülür (yanlış webhook\'a gönderilmez)', () => {
    expect(actionsToPortable([{ type: 'webhook', webhookId: 9 }], new Map())).toEqual([])
    expect(actionsFromPortable([{ type: 'webhook', webhookId: 1, webhookName: 'Yok' } as never], new Map())).toEqual([])
    // eski sürüm blob'u (webhookName yok) → düşer
    expect(actionsFromPortable([{ type: 'webhook', webhookId: 3 }], new Map([['X', 3]]))).toEqual([])
  })
})
