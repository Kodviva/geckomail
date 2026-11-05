import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'crypto'
import { resolve } from 'path'

// Web istemcisi (sunucu modu, tarayıcı): Electron renderer'ıyla aynı kaynak, çıktı out/web. Electron'daki
// inject-csp eklentisi yok — sayfa CSP'si sunucudan başlık olarak gelir (src/server/securityHeaders.ts).
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: '/',
  plugins: [
    react(),
    {
      // PWA başlık etiketleri yalnız web derlemesinde: index.html Electron'la ortak, masaüstü bunlara başvurmaz
      name: 'pwa-head',
      transformIndexHtml: () => [
        { tag: 'meta', attrs: { name: 'theme-color', content: '#10140f' }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' }, injectTo: 'head' },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/icons/icon-192.png' }, injectTo: 'head' }
      ]
    },
    {
      // sw.js'e bu derlemenin kabuk listesi ve kimliği yazılır: dosya adı sabit olsa da her derleme yeni SW demek
      name: 'sw-shell-manifest',
      generateBundle(_options, bundle) {
        const assets = Object.keys(bundle).filter((f) => f.startsWith('assets/')).sort()
        const build = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16)
        const files = ['/', '/manifest.webmanifest', '/icons/icon-192.png', ...assets.map((f) => `/${f}`)]
        const sw = bundle['sw.js']
        if (sw?.type !== 'chunk' || !/(["'`])__GECKO_SHELL__\1/.test(sw.code)) throw new Error('sw.js kabuk yer tutucusu bulunamadı')
        // klasik betik: içe aktarma satırı SW'yi kurulamaz yapar. Sayfayla paylaşılan her modül buraya ortak parça olarak düşer
        if (sw.imports.length || sw.dynamicImports.length) throw new Error(`sw.js sayfayla modül paylaşıyor: ${[...sw.imports, ...sw.dynamicImports].join(', ')}`)
        sw.code = sw.code.replace(/(["'`])__GECKO_SHELL__\1/, JSON.stringify(JSON.stringify({ build, files })))
      }
    }
  ],
  build: {
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true,
    // hash'li dosyalar /assets altında (sunucu bunları kalıcı önbelleğe verir)
    assetsDir: 'assets',
    sourcemap: false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.html'),
        sw: resolve(__dirname, 'src/renderer/src/sw.ts')
      },
      output: {
        // service worker kökte ve sabit adla (kapsamı / olsun; sunucu no-cache verir), gerisi hash'li
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js')
      }
    }
  }
})
