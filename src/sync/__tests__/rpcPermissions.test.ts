import { describe, expect, it } from 'vitest'
import { RpcHub } from '../rpcHub'

// Yetki kümeleri string: yazım hatası bir yöntemi sessizce herkese açar. Her ad kayıtlı bir handler olmalı.
describe('RPC yetki kümeleri', () => {
  const cases = new Set(RpcHub.methodNames())
  const { publicMethods, adminOnly, desktopOnly, serverOnly } = RpcHub.permissionSets()

  it('PUBLIC_METHODS adları gerçek yöntemler', () => {
    for (const m of publicMethods) expect(cases.has(m), m).toBe(true)
  })
  it('ADMIN_ONLY_METHODS adları gerçek yöntemler', () => {
    for (const m of adminOnly) expect(cases.has(m), m).toBe(true)
  })
  it('SERVER_ONLY_METHODS adları gerçek yöntemler', () => {
    for (const m of serverOnly) expect(cases.has(m), m).toBe(true)
  })
  it('masaüstü ajanı yöntemleri girişli oturum ister, yalnız sunucu modunda, yönetici gerekmez', () => {
    for (const m of ['registerDesktopAgent', 'notifyAction', 'notifyBacklog']) {
      expect(serverOnly, m).toContain(m)
      expect(publicMethods, m).not.toContain(m)
      expect(adminOnly, m).not.toContain(m)
      expect(desktopOnly, m).not.toContain(m)
    }
  })
  it('masaüstü modunda ajan yöntemleri bilinmeyen yöntem gibi reddedilir', async () => {
    const hub = new RpcHub({ q: { getAccountRows: () => [], userCount: () => 0 } } as never, 'desktop')
    const session = { currentUser: { id: 1, role: 'admin' } } as never
    for (const m of serverOnly) await expect(hub.invoke(session, m, {}), m).rejects.toThrow()
  })
  it('taşıma yöntemleri yönetici ve yalnız sunucu; plan ve mühürleme RPC yöntemi değil', () => {
    for (const m of ['importBegin', 'importItem', 'importFinish']) {
      expect(adminOnly, m).toContain(m)
      expect(serverOnly, m).toContain(m)
    }
    expect([...cases].filter((m) => /seal|plan/i.test(m))).toEqual([])
  })
  it('hassas yöntemler yönetici yetkisi ister', () => {
    for (const m of ['serverAdminSetConfig', 'serverAdminUnblock', 'serverAdminAllow', 'setPrefs', 'importAccounts', 'backupToFile', 'stageRestore', 'syncPull', 'createVault', 'createUser', 'createWebhook', 'smimeAddAnchor', 'smimeRemoveAnchor', 'clearVaultPassphraseFails']) {
      expect(adminOnly, m).toContain(m)
    }
  })
})

describe('RPC handler haritası', () => {
  it('alan dosyaları arasında aynı ad yok (yayılımda biri sessizce ezilirdi)', async () => {
    const maps = await Promise.all(
      ['accounts', 'auth', 'automation', 'compose', 'mail', 'system', 'serverAdmin', 'oauth', 'twoFactor', 'notifyRules', 'import', 'sieve', 'pimSources', 'contacts', 'calendar', 'invites', 'smime'].map(async (d) => Object.keys((await import(`../rpc/${d}.ts`))[`${d}Handlers`]))
    )
    const all = maps.flat()
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBe(RpcHub.methodNames().length)
  })
})
