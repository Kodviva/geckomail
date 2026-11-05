import { defineConfig } from 'vite'
import { resolve } from 'path'

// Yalnız uçtan uca testler: push testinin sunucusu ve sahte sağlayıcılı röle (out/e2e-server). Üretim paketine ve imaja girmez; ayarlar
// vite.server.config.ts ile aynı.
export default defineConfig({
  build: {
    ssr: true,
    outDir: 'out/e2e-server',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      input: { index: resolve(__dirname, 'e2e/pushServer.ts'), relay: resolve(__dirname, 'e2e/relayServer.ts') },
      output: { format: 'es', entryFileNames: '[name].mjs' }
    }
  },
  ssr: {
    noExternal: true,
    external: ['better-sqlite3', 'ws', 'bufferutil', 'utf-8-validate']
  }
})
