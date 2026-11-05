import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { defineConfig } from 'vite'

// Mobil kabuk: arayüz src/renderer'dan gelir, giriş mobile/src/boot.ts. Çıktı mobile/dist, Capacitor bunu uygulamaya gömer.
// Vite ve React kök node_modules'tan: kabuk yalnız Capacitor paketlerini ekler.
// --mode development: taban CSP geri döngüdeki yerel sunucuya da izin verir (Android'de `adb reverse` gerekir: 10.0.2.2 https
// sayfadan karışık içerik olarak engellenir). Üretim paketinde yok.
export default defineConfig(({ mode }) => ({
  root: __dirname,
  base: './',
  publicDir: resolve(__dirname, '../src/renderer/public'),
  plugins: [
    react(),
    {
      name: 'debug-csp',
      transformIndexHtml: (html) => (mode === 'development' ? html.replace("https: wss:;", 'https: wss: http://localhost:* ws://localhost:*;') : html)
    }
  ],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false
  }
}))
