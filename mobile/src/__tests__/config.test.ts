import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import config from '../../capacitor.config'

describe('capacitor.config', () => {
  it('kimlik ve şemalar', () => {
    expect(config.appId).toBe('com.kodviva.geckomail')
    expect(config.appName).toBe('GeckoMail')
    expect(config.webDir).toBe('dist')
    expect(config.server).toEqual({ androidScheme: 'https', iosScheme: 'capacitor', hostname: 'localhost' })
  })

  it('uzak içerik açılmaz', () => {
    expect(config.server?.url).toBeUndefined()
    expect(config.server?.allowNavigation).toBeUndefined()
    expect(config.server?.cleartext).toBeUndefined()
  })

  it('CapacitorHttp ve CapacitorCookies kapalı', () => {
    expect(config.plugins?.CapacitorHttp).toEqual({ enabled: false })
    expect(config.plugins?.CapacitorCookies).toEqual({ enabled: false })
  })

  it('günlük ve hata ayıklama kapalı', () => {
    expect(config.loggingBehavior).toBe('none')
    expect(config.android?.webContentsDebuggingEnabled).toBe(false)
  })

  it('Capacitor yalnız mobile altında', () => {
    const root = join(__dirname, '../../..')
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { dependencies?: object; devDependencies?: object }
    expect(JSON.stringify([pkg.dependencies, pkg.devDependencies])).not.toContain('@capacitor')
    // grep eşleşme yoksa 1 ile çıkar
    const hits = spawnSync('grep', ['-rlE', "from '@capacitor/", join(root, 'src/renderer/src')], { encoding: 'utf-8' })
    expect(hits.stdout.trim()).toBe('')
  })

  it('klavye yerel yeniden boyutlandırır', () => {
    expect(config.ios?.handleApplicationNotifications).toBe(false)
    expect(config.plugins?.Keyboard).toMatchObject({ resize: 'native' })
  })
})
