// Yerel kaynak metni üzerinden sözleşmeler: JS yüzeyinde uzun ömürlü belirteç yok, iki platformda köprü izin listesi aynı.
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { GeckoNativePlugin } from '../../../src/renderer/src/platform/nativeBridge'

const read = (p: string): string => readFileSync(join(__dirname, '../..', p), 'utf8')
const swift = read('ios/App/App/GeckoNativePlugin.swift')
const kotlin = read('android/app/src/main/java/com/kodviva/geckomail/GeckoNativePlugin.kt')
const gateSwift = read('ios/App/App/BridgeGate.swift')
const gateKotlin = read('android/app/src/main/java/com/kodviva/geckomail/BridgeGate.kt')

const allowed = (src: string): string[] => [...(/allowedPlugins[^=]*=\s*(?:setOf\()?\[?([^\])\n]+)/.exec(src)?.[1].matchAll(/"([^"]+)"/g) ?? [])].map((m) => m[1]).sort()

describe('yerel yüzey', () => {
  it('plugin exposes no token', () => {
    type Keys<T> = T extends object ? keyof T : never
    expectTypeOf<'token'>().not.toMatchTypeOf<Keys<Awaited<ReturnType<GeckoNativePlugin['login']>>>>()
    expectTypeOf<'token'>().not.toMatchTypeOf<Keys<Awaited<ReturnType<GeckoNativePlugin['getServer']>>>>()
    expectTypeOf<'token'>().not.toMatchTypeOf<Keys<Awaited<ReturnType<GeckoNativePlugin['takePending']>>>>()
    // yanıta "token" yalnız accessToken yönteminde, erişim belirteci olarak girer
    for (const src of [swift, kotlin]) {
      expect(src.match(/"token"/g)?.length).toBe(1)
      expect(src).not.toMatch(/store\.token\(\)/)
    }
  })

  it('accessToken kilit kapısından geçer', () => {
    for (const src of [swift, kotlin]) expect(src.slice(src.indexOf('accessToken')).indexOf('isLocked()')).toBeGreaterThan(-1)
  })

  it('köprü izin listesi iki platformda aynı ve dar', () => {
    expect(allowed(gateSwift)).toEqual(['App', 'GeckoNative', 'SplashScreen', 'StatusBar'])
    expect(allowed(gateKotlin)).toEqual(allowed(gateSwift))
  })
})
