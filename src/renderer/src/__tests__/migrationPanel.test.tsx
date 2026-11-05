import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../rpcClient', () => ({ rpc: { call: vi.fn(async () => ({})) } }))

import '../../../shared/i18n/locales/all'
import { t } from '../../../shared/i18n'
import MigrationPanel from '../components/MigrationPanel'
import type { MigrationApi } from '../platform'

const api: MigrationApi = { start: vi.fn(), state: vi.fn(async () => ({ importedTo: null })), onEvent: vi.fn(() => () => {}) }

describe('MigrationPanel', () => {
  const html = renderToStaticMarkup(<MigrationPanel api={api} serverMode={null} />)

  it('taşınamayanların hepsi arayüzde yazılı', () => {
    expect(html.match(/<li /g)).toHaveLength(13)
    for (const k of ['vault', 'vaultServer', 'oauth', 'keys', 'device', 'users', 'queue', 'cache', 'secondDesktop', 'rotated', 'sieve', 'pim', 'smime']) {
      expect(t(`set.migrate.limit.${k}`)).not.toBe(`set.migrate.limit.${k}`)
    }
  })

  it('başlangıçta otomasyon anahtarı görünmez, çalıştırma adres ister', () => {
    expect(html).not.toContain('role="switch"')
    expect(html).toMatch(/<button[^>]*disabled/)
  })
})
