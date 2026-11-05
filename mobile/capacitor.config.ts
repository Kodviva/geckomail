// Arayüz uygulamaya gömülüdür: server.url ve allowNavigation bilerek yok, sunucu uygulamada kod çalıştıramaz.
// CapacitorHttp ve CapacitorCookies kapalı: istekler sayfa CSP'sinden çıkmasın, çerez köprüsü olmasın.
import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.kodviva.geckomail',
  appName: 'GeckoMail',
  webDir: 'dist',
  server: { androidScheme: 'https', iosScheme: 'capacitor', hostname: 'localhost' },
  loggingBehavior: 'none',
  android: { webContentsDebuggingEnabled: false },
  // bildirim temsilcisi PushCenter'ındır: Capacitor'ın yönlendiricisi alırsa dokunuş ve eylemler kaybolur
  ios: { handleApplicationNotifications: false },
  plugins: {
    CapacitorHttp: { enabled: false },
    CapacitorCookies: { enabled: false },
    Keyboard: { resize: 'native' }
  }
}

export default config
