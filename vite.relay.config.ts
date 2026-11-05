import { defineConfig } from 'vite'
import { resolve } from 'path'

// geckomail-relay paketi: tek dosya out/relay/index.mjs. Yalnız better-sqlite3 çalışma ortamındaki node_modules'tan gelir.
export default defineConfig({
  build: {
    ssr: resolve(__dirname, 'src/relay/index.ts'),
    outDir: 'out/relay',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'index.mjs' }
    }
  },
  ssr: {
    noExternal: true,
    external: ['better-sqlite3']
  }
})
