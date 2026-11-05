// Sunucu süreci girişi: ortamdan yapılandırma, komut satırı. Çıkış kodları: 1 hata, 2 yapılandırma, 3 ölümcül
// (ev sahibinin fatal'ı, ör. DB bu sürümden yeni).
import { runCli } from './cli'
import { configErrorText, configFromEnv, type ServerConfig } from './config'

let cfg: ServerConfig
try {
  cfg = configFromEnv(process.env)
} catch (e) {
  // yapılandırma hatası: değişken adı iletide, değer yok
  process.stderr.write(configErrorText((e as Error).message))
  process.exit(2)
}

runCli(process.argv.slice(2), process, cfg).then(
  (code) => process.exit(code),
  (e: Error) => {
    process.stderr.write(`gecko: ${e.message}\n`)
    process.exit(1)
  }
)
