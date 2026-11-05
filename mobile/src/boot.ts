// Mobil giriş noktası: Capacitor burada kalır, src/renderer @capacitor/* görmez. Sunucu ana paketten önce okunur: Platform
// eşzamanlı kurulur ve CSP ana paket çalışmadan daralır.
import { App } from '@capacitor/app'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { SplashScreen } from '@capacitor/splash-screen'
import { StatusBar, Style } from '@capacitor/status-bar'
import type { GeckoNativePlugin, NativeOS } from '../../src/renderer/src/platform/nativeBridge'
import { applyServerCsp } from './csp'

async function boot(): Promise<void> {
  const plugin = registerPlugin<GeckoNativePlugin>('GeckoNative')
  const os = Capacitor.getPlatform() as NativeOS
  const dev = import.meta.env.MODE === 'development'
  const serverOrigin = (await plugin.getServer().catch(() => ({ origin: null }))).origin
  if (serverOrigin) applyServerCsp(document, serverOrigin)
  ;(globalThis as { __geckoNative?: unknown }).__geckoNative = { plugin, os, serverOrigin, dev }

  await import('../../src/renderer/src/main')

  const dark = window.matchMedia('(prefers-color-scheme: dark)')
  const applyBar = (): void => void StatusBar.setStyle({ style: dark.matches ? Style.Dark : Style.Light }).catch(() => {})
  applyBar()
  dark.addEventListener('change', applyBar)
  // arayüz Capacitor görmez: uygulama kilidi bu özel olayı dinler (components/AppLock.tsx)
  void App.addListener('appStateChange', ({ isActive }) => window.dispatchEvent(new CustomEvent('gecko:app-state', { detail: { active: isActive } })))
  // Android geri tuşu: önce sayfa geçmişi, kök ekranda uygulama arka plana gider
  void App.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) window.history.back()
    else void App.minimizeApp()
  })
  void SplashScreen.hide().catch(() => {})
}

void boot()
