import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  main: {
    // sync = utilityProcess girişi; main ile aynı build'de ikinci entry
    // postal-mime, plist, ical.js, pkijs ve asn1js salt-ESM olduğundan bundle'a dahil edilir (CJS çıktıda require edilemez)
    plugins: [externalizeDepsPlugin({ exclude: ['postal-mime', 'plist', 'ical.js', 'pkijs', 'asn1js'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          sync: resolve(__dirname, 'src/sync/index.ts'),
          // takvim alım kapısı: ayrı dosya, worker_threads ile yüklenir
          pimGate: resolve(__dirname, 'src/sync/pim/gateWorker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // sandbox preload'u yerel parça yükleyemez: girişler ortak modül paylaşmamalı
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          server: resolve(__dirname, 'src/preload/server.ts')
        }
      }
    }
  },
  renderer: {
    plugins: [
      react(),
      {
        // prod build'de sıkı CSP; dev'de vite HMR inline script kullandığından eklenmez
        name: 'inject-csp',
        apply: 'build',
        transformIndexHtml(html: string) {
          return html.replace(
            '<head>',
            `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'">`
          )
        }
      }
    ]
  }
})
