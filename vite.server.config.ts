import { defineConfig } from 'vite'
import { resolve } from 'path'

// Sunucu modu paketi (Docker/Node): tek dosya out/server/index.mjs. Göç dosyaları ?raw ile gömülür;
// yerel/ikili bağımlılıklar dışarıda kalır ve çalışma ortamında node_modules'tan yüklenir.
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'out/server',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      // pimGate: takvim alım kapısı, worker_threads ile yüklenir
      input: { index: resolve(__dirname, 'src/server/index.ts'), pimGate: resolve(__dirname, 'src/sync/pim/gateWorker.ts') },
      output: { format: 'es', entryFileNames: '[name].mjs', chunkFileNames: 'chunks/[name]-[hash].mjs' }
    }
  },
  ssr: {
    // paketlenecekler dışında her şey (postal-mime, plist, ical.js salt-ESM) gömülür; yalnız bunlar dış
    noExternal: true,
    external: ['better-sqlite3', 'ws', 'bufferutil', 'utf-8-validate']
  }
})
