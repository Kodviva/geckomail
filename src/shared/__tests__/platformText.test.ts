import { afterEach, describe, expect, it } from 'vitest'
import { getUiOs, setLocale, setUiOs, t } from '../i18n'
import { CATALOGS } from '../i18n/locales'
import '../i18n/locales/all'
import { biometricName, platformText, uiOsOf } from '../platformText'

describe('platformText', () => {
  it('windows: tuş simgeleri yazıya döner', () => {
    expect(platformText('⌘K', 'windows')).toBe('Ctrl+K')
    expect(platformText('Kalın (⌘B)', 'windows')).toBe('Kalın (Ctrl+B)')
    expect(platformText('⌘+tık: çoklu seçim', 'windows')).toBe('Ctrl+tık: çoklu seçim')
    expect(platformText('⇧⌘,', 'windows')).toBe('Ctrl+Shift+,')
    expect(platformText('Gönder (⌘↵)', 'windows')).toBe('Gönder (Ctrl+Enter)')
  })
  it('mac ve diğerleri: dokunulmaz', () => {
    expect(platformText('⌘K', 'mac')).toBe('⌘K')
    expect(platformText('⌘K', 'other')).toBe('⌘K')
  })
})

describe('biometricName', () => {
  it('işletim sistemine göre', () => {
    expect(biometricName('mac')).toBe('Touch ID')
    expect(biometricName('windows')).toBe('Windows Hello')
    expect(biometricName('other')).toBeNull()
  })
})

describe('uiOsOf', () => {
  it('process.platform ve dataset.os değerleri', () => {
    expect(uiOsOf('darwin')).toBe('mac')
    expect(uiOsOf('win32')).toBe('windows')
    expect(uiOsOf('linux')).toBe('other')
    expect(uiOsOf(undefined)).toBe('other')
  })
})

describe('t platform uyumu', () => {
  afterEach(() => {
    setUiOs('mac')
    setLocale('tr')
  })

  it('varsayılan mac: metinler bugünkü gibi', () => {
    expect(getUiOs()).toBe('mac')
    expect(t('acct.login.touchId', { user: 'ali' })).toBe('Touch ID ile giriş · ali')
    expect(t('compose.rich.bold')).toBe('Kalın (⌘B)')
    expect(t('set.vault.touchUnlock')).toBe('Touch ID ile aç')
  })
  it('windows: biyometri adı ve kısayol', () => {
    setUiOs('windows')
    expect(t('acct.login.touchId', { user: 'ali' })).toBe('Windows Hello ile giriş · ali')
    expect(t('compose.rich.bold')).toBe('Kalın (Ctrl+B)')
    expect(t('set.vault.touchUnlock')).toBe('Windows Hello ile aç')
  })
  it('diğer yer tutucular rich için kalır', () => {
    expect(t('set.vault.noVault')).toContain('{action}')
    expect(t('set.vault.noVault')).toContain('Touch ID')
  })
  it('hiçbir dilde Keychain ya da Mac adı kalmadı (keychainWait hariç)', () => {
    for (const [lang, cat] of Object.entries(CATALOGS)) {
      for (const k of ['set.vault.touchLoginHint', 'set.vault.touchUnlockHint', 'set.backup.createHint', 'set.backup.weeklyHint', 'set.server.keyHint', 'acct.import.securityNote', 'sync.server.keyDecryptFailed', 'main.attach.dangerousDetail']) {
        expect({ lang, k, v: /Keychain|Anahtar Zinciri|Schlüsselbund|Llavero|Trousseau|Acesso às Chaves|Связк|سلسلة|キーチェーン|钥匙串|macOS|\bMacs?\b/.test(cat![k]) }).toEqual({ lang, k, v: false })
      }
    }
  })
})
